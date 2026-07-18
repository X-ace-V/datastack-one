import { afterEach, describe, expect, it } from "vitest";
import { openStore, type WarehouseStore } from "./duckdb.js";
import {
  appendMessage,
  deleteSession,
  getSession,
  insertSession,
  listMessages,
  listSessions,
  renameSession,
  updateSessionModel,
} from "./sessions.js";

/**
 * Unit tests for the session store (V1.1, FR1). They assert the desired persisted *values*
 * — the OpenCode id as the key, the nullable-model default, monotonic per-session `seq`,
 * activity-first ordering, and the delete cascade — not merely that the calls run. They also
 * prove the writes are parameterized (a SQL-injection title is stored as literal text).
 */
describe("session store", () => {
  const open: WarehouseStore[] = [];

  afterEach(async () => {
    await Promise.all(open.splice(0).map((s) => s.close()));
  });

  async function freshStore(): Promise<WarehouseStore> {
    const store = await openStore(":memory:");
    open.push(store);
    return store;
  }

  it("persists a session under its OpenCode id with a null model default", async () => {
    const store = await freshStore();
    const session = await insertSession(store, {
      id: "ses_abc",
      title: "Loan review",
    });

    expect(session.id).toBe("ses_abc");
    expect(session.title).toBe("Loan review");
    // Model unset → null, not undefined or "".
    expect(session.model).toBeNull();
    expect(session.createdAt).toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(session.updatedAt).toMatch(/\d{4}-\d{2}-\d{2}/);

    const readBack = await getSession(store, "ses_abc");
    expect(readBack).toEqual(session);
  });

  it("stores an explicit per-session model", async () => {
    const store = await freshStore();
    const session = await insertSession(store, {
      id: "ses_m",
      title: "Quality run",
      model: "anthropic/claude-fable-5",
    });
    expect(session.model).toBe("anthropic/claude-fable-5");
  });

  it("returns null for an unknown session", async () => {
    const store = await freshStore();
    expect(await getSession(store, "nope")).toBeNull();
  });

  it("lists sessions most-recently-active first", async () => {
    const store = await freshStore();
    await insertSession(store, { id: "ses_1", title: "First" });
    await insertSession(store, { id: "ses_2", title: "Second" });
    // Activity on ses_1 (a new message) bumps its updated_at above ses_2.
    await appendMessage(store, {
      sessionId: "ses_1",
      role: "user",
      content: "hi",
    });

    const ids = (await listSessions(store)).map((s) => s.id);
    expect(ids).toEqual(["ses_1", "ses_2"]);
  });

  it("renames a session and bumps it, or returns null when unknown", async () => {
    const store = await freshStore();
    await insertSession(store, { id: "ses_r", title: "Old" });

    const renamed = await renameSession(store, "ses_r", "New name");
    expect(renamed?.title).toBe("New name");
    expect((await getSession(store, "ses_r"))?.title).toBe("New name");

    expect(await renameSession(store, "missing", "x")).toBeNull();
  });

  it("sets a session's model, clears it, or returns null when unknown", async () => {
    const store = await freshStore();
    await insertSession(store, { id: "ses_mm", title: "Session" });

    // A fresh session has no model override.
    expect((await getSession(store, "ses_mm"))?.model).toBeNull();

    const set = await updateSessionModel(store, "ses_mm", "anthropic/claude-opus-4-5");
    expect(set?.model).toBe("anthropic/claude-opus-4-5");
    expect((await getSession(store, "ses_mm"))?.model).toBe("anthropic/claude-opus-4-5");

    // Null clears the override back to the platform default.
    const cleared = await updateSessionModel(store, "ses_mm", null);
    expect(cleared?.model).toBeNull();
    expect((await getSession(store, "ses_mm"))?.model).toBeNull();

    // An unknown id updates nothing and reports null so a caller can 404.
    expect(await updateSessionModel(store, "missing", "opencode/big-pickle")).toBeNull();
  });

  it("assigns monotonic, per-session, gap-free message sequences", async () => {
    const store = await freshStore();
    await insertSession(store, { id: "s1", title: "One" });
    await insertSession(store, { id: "s2", title: "Two" });

    const a = await appendMessage(store, {
      sessionId: "s1",
      role: "user",
      content: "first",
    });
    const b = await appendMessage(store, {
      sessionId: "s1",
      role: "assistant",
      content: "reply",
    });
    // s2's sequence is independent of s1's.
    const c = await appendMessage(store, {
      sessionId: "s2",
      role: "user",
      content: "other",
    });

    expect(a.seq).toBe(0);
    expect(b.seq).toBe(1);
    expect(c.seq).toBe(0);

    const history = await listMessages(store, "s1");
    expect(history.map((m) => [m.seq, m.role, m.content])).toEqual([
      [0, "user", "first"],
      [1, "assistant", "reply"],
    ]);
    expect((await listMessages(store, "s2")).map((m) => m.content)).toEqual([
      "other",
    ]);
  });

  it("deletes a session and its history, reporting whether it existed", async () => {
    const store = await freshStore();
    await insertSession(store, { id: "ses_d", title: "Doomed" });
    await appendMessage(store, {
      sessionId: "ses_d",
      role: "user",
      content: "hi",
    });

    expect(await deleteSession(store, "ses_d")).toBe(true);
    expect(await getSession(store, "ses_d")).toBeNull();
    // The transcript is removed with its session — no orphaned messages.
    expect(await listMessages(store, "ses_d")).toEqual([]);
    // A second delete finds nothing.
    expect(await deleteSession(store, "ses_d")).toBe(false);
  });

  it("stores a session title verbatim through a SQL-injection attempt", async () => {
    const store = await freshStore();
    const payload = `evil"; DROP TABLE platform.sessions; --`;
    const session = await insertSession(store, { id: "ses_x", title: payload });
    expect(session.title).toBe(payload);
    // The table survived (a concatenated title would have dropped it).
    expect((await listSessions(store)).length).toBe(1);
  });
});
