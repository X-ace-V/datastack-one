import { afterEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "./app.js";
import { openStore, type WarehouseStore } from "./store/duckdb.js";
import { SessionManager, type SessionManagerClient } from "./opencode/sessions.js";
import {
  MessageSchema,
  SessionSchema,
  SessionWithHistorySchema,
} from "./core/sessions.js";

/**
 * Route tests for `POST/GET/PATCH/DELETE /api/sessions` and `GET /api/sessions/:id` (V1.2,
 * FR1). They drive the real Fastify app via `app.inject` against a real in-memory store,
 * with the OpenCode runtime a *mocked* client (no `opencode` subprocess) — so the full path
 * (validation → SessionManager → parameterized persist → read-back) is exercised, and the
 * desired HTTP contract is asserted: 201 with a schema-valid session, 200 list newest-first,
 * 200 session-with-history, 200 rename, 204 delete, 404 unknown, 400 bad body, 502 runtime,
 * and 503 when the manager is unwired.
 */
describe("session routes", () => {
  const open: WarehouseStore[] = [];

  afterEach(async () => {
    await Promise.all(open.splice(0).map((s) => s.close()));
    prompt.mockClear();
  });

  /**
   * A mocked session client: `create` echoes the requested title under a stable id;
   * `update`/`delete` succeed. Pass `createError`/`updateError`/`deleteError` to simulate a
   * runtime error envelope on that call, so a route's 502 path can be exercised.
   */
  const prompt = vi.fn(() =>
    Promise.resolve({ data: { info: {}, parts: [] }, error: undefined }),
  );

  function mockClient(
    opts: {
      createError?: unknown;
      updateError?: unknown;
      deleteError?: unknown;
      abortError?: unknown;
    } = {},
  ): SessionManagerClient {
    let counter = 0;
    return {
      session: {
        create: vi.fn(async ({ body }: { body?: { title?: string } }) => {
          if (opts.createError) return { data: undefined, error: opts.createError };
          counter += 1;
          return { data: { id: `ses_${counter}`, title: body?.title ?? "" }, error: undefined };
        }),
        update: vi.fn(async () =>
          opts.updateError
            ? { data: undefined, error: opts.updateError }
            : { data: {}, error: undefined },
        ),
        delete: vi.fn(async () =>
          opts.deleteError
            ? { data: undefined, error: opts.deleteError }
            : { data: true, error: undefined },
        ),
        prompt,
        abort: vi.fn(async () =>
          opts.abortError
            ? { data: undefined, error: opts.abortError }
            : { data: true, error: undefined },
        ),
      },
    } as never;
  }

  async function appWith(client: SessionManagerClient) {
    const store = await openStore(":memory:");
    open.push(store);
    const sessions = new SessionManager(client, store);
    return buildServer({ sessions });
  }

  it("creates a session and returns 201 with the persisted row", async () => {
    const app = await appWith(mockClient());
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { title: "Loan review", model: "opencode/big-pickle" },
    });

    expect(res.statusCode).toBe(201);
    const session = SessionSchema.parse(res.json());
    expect(session.id).toBe("ses_1");
    expect(session.title).toBe("Loan review");
    expect(session.model).toBe("opencode/big-pickle");
    expect(session.createdAt).toBeTruthy();
  });

  it("defaults the title and leaves model null when the body is empty", async () => {
    const app = await appWith(mockClient());
    const res = await app.inject({ method: "POST", url: "/api/sessions", payload: {} });

    expect(res.statusCode).toBe(201);
    const session = SessionSchema.parse(res.json());
    expect(session.title).toBe("New session");
    expect(session.model).toBeNull();
  });

  it("rejects a whitespace-only title with 400", async () => {
    const app = await appWith(mockClient());
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { title: "   " },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toHaveProperty("error");
  });

  it("reports 502 when the runtime fails to open the session", async () => {
    const app = await appWith(mockClient({ createError: { message: "runtime down" } }));
    const res = await app.inject({ method: "POST", url: "/api/sessions", payload: {} });
    expect(res.statusCode).toBe(502);
    // Nothing was persisted, so the list is empty.
    const list = await app.inject({ method: "GET", url: "/api/sessions" });
    expect((list.json() as { sessions: unknown[] }).sessions).toEqual([]);
  });

  it("lists sessions, most recently active first", async () => {
    const app = await appWith(mockClient());
    await app.inject({ method: "POST", url: "/api/sessions", payload: { title: "First" } });
    const second = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { title: "Second" },
    });
    const secondId = SessionSchema.parse(second.json()).id;
    // Renaming the first floats it back above the second.
    const first = await app.inject({ method: "GET", url: "/api/sessions" });
    const firstId = (first.json() as { sessions: { id: string; title: string }[] }).sessions
      .find((s) => s.title === "First")!.id;
    await app.inject({
      method: "PATCH",
      url: `/api/sessions/${firstId}`,
      payload: { title: "First (renamed)" },
    });

    const res = await app.inject({ method: "GET", url: "/api/sessions" });
    expect(res.statusCode).toBe(200);
    const sessions = (res.json() as { sessions: unknown[] }).sessions.map((s) =>
      SessionSchema.parse(s),
    );
    expect(sessions.map((s) => s.id)).toEqual([firstId, secondId]);
    expect(sessions[0]?.title).toBe("First (renamed)");
  });

  it("returns a session with its message history", async () => {
    const client = mockClient();
    const store = await openStore(":memory:");
    open.push(store);
    const manager = new SessionManager(client, store);
    const app = buildServer({ sessions: manager });

    const created = SessionSchema.parse(
      (await app.inject({ method: "POST", url: "/api/sessions", payload: {} })).json(),
    );
    // Seed a transcript through the manager (the chat turn, V1.3, will do this at runtime).
    await manager.appendMessage(created.id, "user", "profile this");
    await manager.appendMessage(created.id, "assistant", "here is the profile");

    const res = await app.inject({ method: "GET", url: `/api/sessions/${created.id}` });
    expect(res.statusCode).toBe(200);
    const session = SessionWithHistorySchema.parse(res.json());
    expect(session.messages.map((m) => [m.seq, m.role, m.content])).toEqual([
      [0, "user", "profile this"],
      [1, "assistant", "here is the profile"],
    ]);
  });

  it("returns 404 for an unknown session id", async () => {
    const app = await appWith(mockClient());
    const res = await app.inject({ method: "GET", url: "/api/sessions/nope" });
    expect(res.statusCode).toBe(404);
  });

  it("renames a session and returns the updated row", async () => {
    const app = await appWith(mockClient());
    const created = SessionSchema.parse(
      (await app.inject({ method: "POST", url: "/api/sessions", payload: {} })).json(),
    );
    const res = await app.inject({
      method: "PATCH",
      url: `/api/sessions/${created.id}`,
      payload: { title: "Renamed" },
    });
    expect(res.statusCode).toBe(200);
    expect(SessionSchema.parse(res.json()).title).toBe("Renamed");
  });

  it("rejects a rename with a missing title with 400", async () => {
    const app = await appWith(mockClient());
    const created = SessionSchema.parse(
      (await app.inject({ method: "POST", url: "/api/sessions", payload: {} })).json(),
    );
    const res = await app.inject({
      method: "PATCH",
      url: `/api/sessions/${created.id}`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 404 renaming an unknown session", async () => {
    const app = await appWith(mockClient());
    const res = await app.inject({
      method: "PATCH",
      url: "/api/sessions/nope",
      payload: { title: "x" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 502 when the runtime fails to rename", async () => {
    const app = await appWith(mockClient({ updateError: { message: "runtime down" } }));
    const created = SessionSchema.parse(
      (await app.inject({ method: "POST", url: "/api/sessions", payload: {} })).json(),
    );
    const res = await app.inject({
      method: "PATCH",
      url: `/api/sessions/${created.id}`,
      payload: { title: "Renamed" },
    });
    expect(res.statusCode).toBe(502);
  });

  it("sets a session's per-session model and returns the updated row", async () => {
    const app = await appWith(mockClient());
    const created = SessionSchema.parse(
      (await app.inject({ method: "POST", url: "/api/sessions", payload: {} })).json(),
    );
    const res = await app.inject({
      method: "PATCH",
      url: `/api/sessions/${created.id}`,
      payload: { model: "anthropic/claude-opus-4-5" },
    });
    expect(res.statusCode).toBe(200);
    expect(SessionSchema.parse(res.json()).model).toBe("anthropic/claude-opus-4-5");
    // A model change is store-only metadata — the runtime session is not renamed for it.
    const stored = SessionSchema.parse(
      (await app.inject({ method: "GET", url: `/api/sessions/${created.id}` })).json(),
    );
    expect(stored.model).toBe("anthropic/claude-opus-4-5");
  });

  it("clears a session's model with an explicit null", async () => {
    const app = await appWith(mockClient());
    const created = SessionSchema.parse(
      (
        await app.inject({
          method: "POST",
          url: "/api/sessions",
          payload: { model: "opencode/big-pickle" },
        })
      ).json(),
    );
    const res = await app.inject({
      method: "PATCH",
      url: `/api/sessions/${created.id}`,
      payload: { model: null },
    });
    expect(res.statusCode).toBe(200);
    expect(SessionSchema.parse(res.json()).model).toBeNull();
  });

  it("rejects a malformed model ref with 400", async () => {
    const app = await appWith(mockClient());
    const created = SessionSchema.parse(
      (await app.inject({ method: "POST", url: "/api/sessions", payload: {} })).json(),
    );
    const res = await app.inject({
      method: "PATCH",
      url: `/api/sessions/${created.id}`,
      payload: { model: "no-slash" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 404 setting the model of an unknown session", async () => {
    const app = await appWith(mockClient());
    const res = await app.inject({
      method: "PATCH",
      url: "/api/sessions/nope",
      payload: { model: "opencode/big-pickle" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("deletes a session and returns 204, then 404 on re-fetch", async () => {
    const app = await appWith(mockClient());
    const created = SessionSchema.parse(
      (await app.inject({ method: "POST", url: "/api/sessions", payload: {} })).json(),
    );
    const del = await app.inject({ method: "DELETE", url: `/api/sessions/${created.id}` });
    expect(del.statusCode).toBe(204);
    expect(del.body).toBe("");

    const after = await app.inject({ method: "GET", url: `/api/sessions/${created.id}` });
    expect(after.statusCode).toBe(404);
  });

  it("returns 404 deleting an unknown session", async () => {
    const app = await appWith(mockClient());
    const res = await app.inject({ method: "DELETE", url: "/api/sessions/nope" });
    expect(res.statusCode).toBe(404);
  });

  it("returns 502 when the runtime fails to delete", async () => {
    const app = await appWith(mockClient({ deleteError: { message: "runtime down" } }));
    const created = SessionSchema.parse(
      (await app.inject({ method: "POST", url: "/api/sessions", payload: {} })).json(),
    );
    const res = await app.inject({ method: "DELETE", url: `/api/sessions/${created.id}` });
    expect(res.statusCode).toBe(502);
    // The runtime failed, so the session is still present (nothing removed).
    const after = await app.inject({ method: "GET", url: `/api/sessions/${created.id}` });
    expect(after.statusCode).toBe(200);
  });

  it("accepts a chat turn with 202, persists it, and fires the prompt", async () => {
    const app = await appWith(mockClient());
    const created = SessionSchema.parse(
      (await app.inject({ method: "POST", url: "/api/sessions", payload: {} })).json(),
    );

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${created.id}/chat`,
      payload: { text: "which branch has the most overdue loans?" },
    });
    expect(res.statusCode).toBe(202);
    const message = MessageSchema.parse(res.json());
    expect([message.role, message.content, message.seq]).toEqual([
      "user",
      "which branch has the most overdue loans?",
      0,
    ]);
    // The runtime was prompted with the turn text.
    expect(prompt).toHaveBeenCalledWith({
      path: { id: created.id },
      body: {
        parts: [
          { type: "text", text: "which branch has the most overdue loans?" },
        ],
      },
    });
    // The user turn is now in the session's persisted history.
    const withHistory = SessionWithHistorySchema.parse(
      (await app.inject({ method: "GET", url: `/api/sessions/${created.id}` })).json(),
    );
    expect(withHistory.messages.map((m) => m.content)).toEqual([
      "which branch has the most overdue loans?",
    ]);
  });

  it("threads the session's model into the chat prompt", async () => {
    const app = await appWith(mockClient());
    const created = SessionSchema.parse(
      (
        await app.inject({
          method: "POST",
          url: "/api/sessions",
          payload: { model: "opencode/big-pickle" },
        })
      ).json(),
    );

    await app.inject({
      method: "POST",
      url: `/api/sessions/${created.id}/chat`,
      payload: { text: "hi" },
    });
    expect(prompt).toHaveBeenCalledWith({
      path: { id: created.id },
      body: {
        parts: [{ type: "text", text: "hi" }],
        model: { providerID: "opencode", modelID: "big-pickle" },
      },
    });
  });

  it("rejects an empty chat turn with 400 and never prompts", async () => {
    const app = await appWith(mockClient());
    const created = SessionSchema.parse(
      (await app.inject({ method: "POST", url: "/api/sessions", payload: {} })).json(),
    );
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${created.id}/chat`,
      payload: { text: "   " },
    });
    expect(res.statusCode).toBe(400);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("rejects a malformed model ref on a chat turn with 400", async () => {
    const app = await appWith(mockClient());
    const created = SessionSchema.parse(
      (await app.inject({ method: "POST", url: "/api/sessions", payload: {} })).json(),
    );
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${created.id}/chat`,
      payload: { text: "hi", model: "no-slash" },
    });
    expect(res.statusCode).toBe(400);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("returns 404 chatting to an unknown session", async () => {
    const app = await appWith(mockClient());
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/nope/chat",
      payload: { text: "hi" },
    });
    expect(res.statusCode).toBe(404);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("cancels an in-flight turn with 200", async () => {
    const app = await appWith(mockClient());
    const created = SessionSchema.parse(
      (await app.inject({ method: "POST", url: "/api/sessions", payload: {} })).json(),
    );
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${created.id}/cancel`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "cancelled" });
  });

  it("returns 404 cancelling an unknown session", async () => {
    const app = await appWith(mockClient());
    const res = await app.inject({ method: "POST", url: "/api/sessions/nope/cancel" });
    expect(res.statusCode).toBe(404);
  });

  it("returns 502 when the runtime fails to cancel", async () => {
    const app = await appWith(mockClient({ abortError: { message: "runtime down" } }));
    const created = SessionSchema.parse(
      (await app.inject({ method: "POST", url: "/api/sessions", payload: {} })).json(),
    );
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${created.id}/cancel`,
    });
    expect(res.statusCode).toBe(502);
  });

  it("reports 503 for every session route when the manager is unwired", async () => {
    const app = buildServer({});
    for (const call of [
      { method: "POST" as const, url: "/api/sessions", payload: {} },
      { method: "GET" as const, url: "/api/sessions" },
      { method: "GET" as const, url: "/api/sessions/x" },
      { method: "PATCH" as const, url: "/api/sessions/x", payload: { title: "y" } },
      { method: "DELETE" as const, url: "/api/sessions/x" },
      { method: "POST" as const, url: "/api/sessions/x/chat", payload: { text: "hi" } },
      { method: "POST" as const, url: "/api/sessions/x/cancel" },
    ]) {
      const res = await app.inject(call);
      expect(res.statusCode).toBe(503);
    }
  });
});
