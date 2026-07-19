import { afterEach, describe, expect, it, vi } from "vitest";
import { openStore, type WarehouseStore } from "../store/duckdb.js";
import {
  SessionManager,
  SessionRuntimeError,
  type SessionManagerClient,
} from "./sessions.js";
import { SessionAttachmentError, SessionModelError } from "../core/sessions.js";
import { getSession } from "../store/sessions.js";
import { registerSessionSource } from "../store/session-sources.js";
import { connectSessionFolder } from "../store/session-folders.js";

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
    opts: {
      createError?: unknown;
      abortError?: unknown;
      /** When set, `prompt` returns a promise that never resolves — models the long-running,
       *  streamed turn, so a test can prove `chat` returns without awaiting it. */
      promptNeverResolves?: boolean;
    } = {},
  ): SessionManagerClient & {
    session: {
      create: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      delete: ReturnType<typeof vi.fn>;
      prompt: ReturnType<typeof vi.fn>;
      abort: ReturnType<typeof vi.fn>;
      status: ReturnType<typeof vi.fn>;
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
            data: {
              id: `ses_${counter}`,
              title: body?.title ?? "New session - 2026-07-19T00:00:00.000Z",
            },
            error: undefined,
          };
        }),
        update: vi.fn(async () => ({ data: {}, error: undefined })),
        delete: vi.fn(async () => ({ data: true, error: undefined })),
        prompt: vi.fn(() =>
          opts.promptNeverResolves
            ? new Promise(() => {})
            : Promise.resolve({ data: { info: {}, parts: [] }, error: undefined }),
        ),
        abort: vi.fn(async () =>
          opts.abortError
            ? { data: undefined, error: opts.abortError }
            : { data: true, error: undefined },
        ),
        status: vi.fn(async () => ({
          data: { ses_1: { type: "busy" } },
          error: undefined,
        })),
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
    expect(session.title).toBe("New session - 2026-07-19T00:00:00.000Z");
    expect(session.model).toBeNull();
    expect(client.session.create).toHaveBeenCalledWith({
      body: {},
    });
  });

  it("creates OpenCode in the selected folder instead of the backend directory", async () => {
    const store = await freshStore();
    const client = mockClient();
    const manager = new SessionManager(client, store);

    const session = await manager.create({ folderPath: "/allowed/loan-pipeline" });
    expect(session.id).toBe("ses_1");
    expect(client.session.create).toHaveBeenCalledWith({
      body: {},
      query: { directory: "/allowed/loan-pipeline" },
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

  it("mirrors OpenCode's generated title without writing back to the runtime", async () => {
    const store = await freshStore();
    const client = mockClient();
    const manager = new SessionManager(client, store);
    const created = await manager.create();

    const updated = await manager.syncRuntimeTitle(created.id, "Investigate loan defaults");
    expect(updated?.title).toBe("Investigate loan defaults");
    expect((await getSession(store, created.id))?.title).toBe("Investigate loan defaults");
    expect(client.session.update).not.toHaveBeenCalled();
  });

  it("returns OpenCode's live status map for reload recovery", async () => {
    const manager = new SessionManager(mockClient(), await freshStore());
    await expect(manager.status()).resolves.toEqual({ ses_1: { type: "busy" } });
  });

  it("queries live status for every folder-rooted OpenCode instance", async () => {
    const store = await freshStore();
    const client = mockClient();
    const manager = new SessionManager(client, store);
    const created = await manager.create({ folderPath: "/allowed/pipeline" });
    await connectSessionFolder(store, {
      sessionId: created.id,
      name: "pipeline",
      path: "/allowed/pipeline",
      workspaceRoot: true,
    });

    await manager.status();
    expect(client.session.status).toHaveBeenCalledWith({});
    expect(client.session.status).toHaveBeenCalledWith({
      query: { directory: "/allowed/pipeline" },
    });
  });

  it("does not touch the runtime when renaming an unknown session", async () => {
    const store = await freshStore();
    const client = mockClient();
    const manager = new SessionManager(client, store);

    expect(await manager.rename("missing", "New")).toBeNull();
    expect(client.session.update).not.toHaveBeenCalled();
  });

  it("sets a session's model in the store without touching the runtime", async () => {
    const store = await freshStore();
    const client = mockClient();
    const manager = new SessionManager(client, store);
    const created = await manager.create({ title: "Session" });

    const updated = await manager.setModel(created.id, "anthropic/claude-opus-4-5");
    expect(updated?.model).toBe("anthropic/claude-opus-4-5");
    expect((await getSession(store, created.id))?.model).toBe("anthropic/claude-opus-4-5");
    // The model is platform metadata (OpenCode picks it per prompt) — no runtime round-trip.
    expect(client.session.update).not.toHaveBeenCalled();

    // Null clears the override back to the platform default.
    const cleared = await manager.setModel(created.id, null);
    expect(cleared?.model).toBeNull();
  });

  it("does not touch the runtime or store when setting the model of an unknown session", async () => {
    const store = await freshStore();
    const client = mockClient();
    const manager = new SessionManager(client, store);

    expect(await manager.setModel("missing", "opencode/big-pickle")).toBeNull();
    expect(client.session.update).not.toHaveBeenCalled();
  });

  it("rejects a malformed model ref before persisting it", async () => {
    const store = await freshStore();
    const client = mockClient();
    const manager = new SessionManager(client, store);
    const created = await manager.create({ title: "Session", model: "opencode/big-pickle" });

    await expect(manager.setModel(created.id, "no-slash")).rejects.toBeInstanceOf(
      SessionModelError,
    );
    // The stored model is untouched by a failed set.
    expect((await getSession(store, created.id))?.model).toBe("opencode/big-pickle");
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

  it("persists the user turn and fires session.prompt with the text", async () => {
    const store = await freshStore();
    const client = mockClient();
    const manager = new SessionManager(client, store);
    const created = await manager.create({ title: "Chat" });

    const message = await manager.chat(created.id, { text: "profile this csv" });

    // The returned + persisted message is the user's turn at seq 0.
    expect(message).not.toBeNull();
    expect([message!.role, message!.content, message!.seq]).toEqual([
      "user",
      "profile this csv",
      0,
    ]);
    expect((await manager.get(created.id))?.messages.map((m) => m.content)).toEqual([
      "profile this csv",
    ]);
    // The prompt was fired at the runtime with the text and no explicit model (session default).
    expect(client.session.prompt).toHaveBeenCalledWith({
      path: { id: created.id },
      body: { parts: [{ type: "text", text: "profile this csv" }] },
    });
  });

  it("keeps every turn addressed to the session's folder-rooted runtime", async () => {
    const store = await freshStore();
    const client = mockClient();
    const manager = new SessionManager(client, store);
    const created = await manager.create({ folderPath: "/allowed/pipeline" });
    await connectSessionFolder(store, {
      sessionId: created.id,
      name: "pipeline",
      path: "/allowed/pipeline",
      workspaceRoot: true,
    });

    await manager.chat(created.id, { text: "which directory are you in?" });
    expect(client.session.prompt).toHaveBeenCalledWith({
      path: { id: created.id },
      query: { directory: "/allowed/pipeline" },
      body: { parts: [{ type: "text", text: "which directory are you in?" }] },
    });
  });

  it("persists same-session attachments and gives OpenCode only safe source names", async () => {
    const store = await freshStore();
    const client = mockClient();
    const manager = new SessionManager(client, store);
    const created = await manager.create({ title: "Chat" });
    await registerSessionSource(store, {
      sessionId: created.id,
      name: "loans",
      kind: "csv",
      path: "/private/user/customer-data/loans.csv",
      origin: "upload",
    });

    const message = await manager.chat(created.id, {
      text: "find overdue accounts",
      attachments: [{ name: "loans", kind: "csv" }],
    });

    expect(message?.attachments).toEqual([{ name: "loans", kind: "csv" }]);
    expect((await manager.get(created.id))?.messages[0]?.attachments).toEqual([
      { name: "loans", kind: "csv" },
    ]);
    const prompt = client.session.prompt.mock.calls[0]?.[0];
    expect(prompt.body.parts[0].text).toContain("loans (csv)");
    expect(JSON.stringify(prompt)).not.toContain("/private/user");
  });

  it("supports a file-only turn and asks the agent to inspect it", async () => {
    const store = await freshStore();
    const client = mockClient();
    const manager = new SessionManager(client, store);
    const created = await manager.create({ title: "Chat" });
    await registerSessionSource(store, {
      sessionId: created.id,
      name: "pipeline",
      kind: "sql",
      path: "/private/pipeline.sql",
      origin: "upload",
    });

    const message = await manager.chat(created.id, {
      attachments: [{ name: "pipeline", kind: "sql" }],
    });
    expect(message?.content).toBe("");
    expect(client.session.prompt.mock.calls[0]?.[0].body.parts[0].text).toMatch(
      /^Inspect the attached files/i,
    );
  });

  it("rejects an attachment owned by another session before persisting or prompting", async () => {
    const store = await freshStore();
    const client = mockClient();
    const manager = new SessionManager(client, store);
    const alpha = await manager.create({ title: "Alpha" });
    const beta = await manager.create({ title: "Beta" });
    await registerSessionSource(store, {
      sessionId: beta.id,
      name: "private_beta",
      kind: "csv",
      path: "/private/beta.csv",
      origin: "upload",
    });

    await expect(
      manager.chat(alpha.id, {
        text: "inspect it",
        attachments: [{ name: "private_beta", kind: "csv" }],
      }),
    ).rejects.toBeInstanceOf(SessionAttachmentError);
    expect((await manager.get(alpha.id))?.messages).toEqual([]);
    expect(client.session.prompt).not.toHaveBeenCalled();
  });

  it("returns without awaiting the streamed turn to completion", async () => {
    const store = await freshStore();
    // prompt never resolves — a real turn streams for many seconds; chat must not block on it.
    const client = mockClient({ promptNeverResolves: true });
    const manager = new SessionManager(client, store);
    const created = await manager.create({ title: "Chat" });

    const message = await manager.chat(created.id, { text: "hi" });
    expect(message?.content).toBe("hi");
    expect(client.session.prompt).toHaveBeenCalledOnce();
  });

  it("resolves the model as turn-override → session default", async () => {
    const store = await freshStore();
    const client = mockClient();
    const manager = new SessionManager(client, store);
    const created = await manager.create({
      title: "Chat",
      model: "opencode/big-pickle",
    });

    // No override: the session's stored model applies, parsed into provider/model.
    await manager.chat(created.id, { text: "one" });
    expect(client.session.prompt).toHaveBeenLastCalledWith({
      path: { id: created.id },
      body: {
        parts: [{ type: "text", text: "one" }],
        model: { providerID: "opencode", modelID: "big-pickle" },
      },
    });

    // A turn override wins over the session default.
    await manager.chat(created.id, { text: "two", model: "anthropic/claude-sonnet-5" });
    expect(client.session.prompt).toHaveBeenLastCalledWith({
      path: { id: created.id },
      body: {
        parts: [{ type: "text", text: "two" }],
        model: { providerID: "anthropic", modelID: "claude-sonnet-5" },
      },
    });
  });

  it("returns null and never touches the runtime for an unknown session", async () => {
    const store = await freshStore();
    const client = mockClient();
    const manager = new SessionManager(client, store);

    expect(await manager.chat("missing", { text: "hi" })).toBeNull();
    expect(client.session.prompt).not.toHaveBeenCalled();
  });

  it("rejects a malformed model ref before persisting anything", async () => {
    const store = await freshStore();
    const client = mockClient();
    const manager = new SessionManager(client, store);
    const created = await manager.create({ title: "Chat" });

    await expect(
      manager.chat(created.id, { text: "hi", model: "no-slash" }),
    ).rejects.toBeInstanceOf(SessionModelError);
    // No dangling user turn was left behind, and the runtime was never prompted.
    expect((await manager.get(created.id))?.messages).toEqual([]);
    expect(client.session.prompt).not.toHaveBeenCalled();
  });

  it("cancels an in-flight turn via session.abort", async () => {
    const store = await freshStore();
    const client = mockClient();
    const manager = new SessionManager(client, store);
    const created = await manager.create({ title: "Chat" });

    expect(await manager.cancel(created.id)).toBe(true);
    expect(client.session.abort).toHaveBeenCalledWith({ path: { id: created.id } });
  });

  it("does not touch the runtime when cancelling an unknown session", async () => {
    const store = await freshStore();
    const client = mockClient();
    const manager = new SessionManager(client, store);

    expect(await manager.cancel("missing")).toBe(false);
    expect(client.session.abort).not.toHaveBeenCalled();
  });

  it("raises a runtime error when abort fails", async () => {
    const store = await freshStore();
    const client = mockClient({ abortError: { message: "boom" } });
    const manager = new SessionManager(client, store);
    const created = await manager.create({ title: "Chat" });

    await expect(manager.cancel(created.id)).rejects.toBeInstanceOf(
      SessionRuntimeError,
    );
  });
});
