import { afterEach, describe, expect, it, vi } from "vitest";
import { openStore, type WarehouseStore } from "../store/duckdb.js";
import {
  SessionManager,
  SessionRuntimeError,
  type SessionManagerClient,
} from "./sessions.js";
import { getSession } from "../store/sessions.js";

/**
 * Unit tests for the SessionManager (V1.1, FR1). The OpenCode runtime is a *mocked* client
 * (no `opencode` subprocess) and the store is a real in-memory warehouse, so we assert the
 * desired behavior end to end: create opens then persists under the OpenCode id; rename and
 * delete touch both the runtime and the store; an unknown id never reaches the runtime; and
 * a runtime error leaves nothing persisted. See TASKS V1.1 ("test against a mocked client").
 */
describe("SessionManager", () => {
  const open: WarehouseStore[] = [];

  afterEach(async () => {
    await Promise.all(open.splice(0).map((s) => s.close()));
  });

  async function freshStore(): Promise<WarehouseStore> {
    const store = await openStore(":memory:");
    open.push(store);
    return store;
  }

  /**
   * A mocked session client. `create` echoes the requested title under a stable id;
   * `update`/`delete` succeed. Each is a spy so a test can assert the exact call. Pass
   * `createError` to simulate a runtime failure envelope on create.
   */
  function mockClient(
    opts: { createError?: unknown } = {},
  ): SessionManagerClient & {
    session: {
      create: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      delete: ReturnType<typeof vi.fn>;
    };
  } {
    let counter = 0;
    return {
      session: {
        create: vi.fn(async ({ body }: { body?: { title?: string } }) => {
          if (opts.createError) {
            return { data: undefined, error: opts.createError };
          }
          counter += 1;
          return {
            data: { id: `ses_${counter}`, title: body?.title ?? "" },
            error: undefined,
          };
        }),
        update: vi.fn(async () => ({ data: {}, error: undefined })),
        delete: vi.fn(async () => ({ data: true, error: undefined })),
      },
    } as never;
  }

  it("creates an OpenCode session and persists it under its id", async () => {
    const store = await freshStore();
    const client = mockClient();
    const manager = new SessionManager(client, store);

    const session = await manager.create({
      title: "Loan review",
      model: "opencode/big-pickle",
    });

    // The runtime was asked to create with the resolved title.
    expect(client.session.create).toHaveBeenCalledWith({
      body: { title: "Loan review" },
    });
    // Persisted under the OpenCode id, with the model kept as metadata.
    expect(session.id).toBe("ses_1");
    expect(session.title).toBe("Loan review");
    expect(session.model).toBe("opencode/big-pickle");
    expect((await getSession(store, "ses_1"))?.title).toBe("Loan review");
  });

  it("defaults the title and leaves model null when omitted", async () => {
    const store = await freshStore();
    const client = mockClient();
    const manager = new SessionManager(client, store);

    const session = await manager.create();
    expect(session.title).toBe("New session");
    expect(session.model).toBeNull();
    expect(client.session.create).toHaveBeenCalledWith({
      body: { title: "New session" },
    });
  });

  it("persists nothing when the runtime fails to create", async () => {
    const store = await freshStore();
    const client = mockClient({ createError: { message: "boom" } });
    const manager = new SessionManager(client, store);

    await expect(manager.create({ title: "x" })).rejects.toBeInstanceOf(
      SessionRuntimeError,
    );
    expect(await manager.list()).toEqual([]);
  });

  it("returns a session with its ordered history, or null when unknown", async () => {
    const store = await freshStore();
    const manager = new SessionManager(mockClient(), store);
    const created = await manager.create({ title: "Chat" });

    // Fresh session: no messages yet.
    const empty = await manager.get(created.id);
    expect(empty?.messages).toEqual([]);

    await manager.appendMessage(created.id, "user", "profile this");
    await manager.appendMessage(created.id, "assistant", "on it");

    const withHistory = await manager.get(created.id);
    expect(withHistory?.messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "profile this"],
      ["assistant", "on it"],
    ]);

    expect(await manager.get("missing")).toBeNull();
  });

  it("lists created sessions", async () => {
    const store = await freshStore();
    const manager = new SessionManager(mockClient(), store);
    await manager.create({ title: "A" });
    await manager.create({ title: "B" });
    expect((await manager.list()).map((s) => s.title).sort()).toEqual([
      "A",
      "B",
    ]);
  });

  it("renames in both the runtime and the store", async () => {
    const store = await freshStore();
    const client = mockClient();
    const manager = new SessionManager(client, store);
    const created = await manager.create({ title: "Old" });

    const renamed = await manager.rename(created.id, "New");
    expect(renamed?.title).toBe("New");
    expect(client.session.update).toHaveBeenCalledWith({
      path: { id: created.id },
      body: { title: "New" },
    });
    expect((await getSession(store, created.id))?.title).toBe("New");
  });

  it("does not touch the runtime when renaming an unknown session", async () => {
    const store = await freshStore();
    const client = mockClient();
    const manager = new SessionManager(client, store);

    expect(await manager.rename("missing", "New")).toBeNull();
    expect(client.session.update).not.toHaveBeenCalled();
  });

  it("deletes in both the runtime and the store", async () => {
    const store = await freshStore();
    const client = mockClient();
    const manager = new SessionManager(client, store);
    const created = await manager.create({ title: "Doomed" });
    await manager.appendMessage(created.id, "user", "hi");

    expect(await manager.delete(created.id)).toBe(true);
    expect(client.session.delete).toHaveBeenCalledWith({
      path: { id: created.id },
    });
    expect(await getSession(store, created.id)).toBeNull();
    expect(await manager.get(created.id)).toBeNull();
  });

  it("does not touch the runtime when deleting an unknown session", async () => {
    const store = await freshStore();
    const client = mockClient();
    const manager = new SessionManager(client, store);

    expect(await manager.delete("missing")).toBe(false);
    expect(client.session.delete).not.toHaveBeenCalled();
  });
});
