import { afterEach, describe, expect, it } from "vitest";
import { openStore, type WarehouseStore } from "./duckdb.js";
import {
  appendMessage,
  deleteSession,
  getSession,
  insertSession,
  listMessages,
  listSessions,
  persistAssistantMessage,
  renameSession,
  updateSessionModel,
} from "./sessions.js";
import type { PersistedBlock } from "../core/transcript.js";

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

  it("persists an assistant turn with its ordered tool-block history (V6.2)", async () => {
    const store = await freshStore();
    await insertSession(store, { id: "s1", title: "Build" });
    // The user's prompt is persisted first (by the chat turn), so the reply replays after it.
    await appendMessage(store, { sessionId: "s1", role: "user", content: "which branch?" });

    const blocks: PersistedBlock[] = [
      { kind: "reasoning", partID: "r1", text: "I should query the data." },
      {
        kind: "tool",
        callID: "c1",
        tool: "run_query",
        status: "completed",
        input: { sql: "SELECT branch FROM loans" },
        output: "north",
        metadata: { result: { columns: ["branch"], rows: [["north"]] } },
      },
      { kind: "text", partID: "p1", text: "The north branch." },
    ];
    const msg = await persistAssistantMessage(store, {
      sessionId: "s1",
      messageID: "asst_1",
      content: "The north branch.",
      blocks,
    });

    // The OpenCode messageID is the row id; seq follows the user prompt; blocks round-trip.
    expect(msg.id).toBe("asst_1");
    expect(msg.seq).toBe(1);
    expect(msg.role).toBe("assistant");
    expect(msg.content).toBe("The north branch.");
    expect(msg.blocks).toEqual(blocks);

    // Reopening the session replays user text + the assistant turn WITH its tool blocks.
    const history = await listMessages(store, "s1");
    expect(history.map((m) => [m.seq, m.role])).toEqual([
      [0, "user"],
      [1, "assistant"],
    ]);
    expect(history[1]?.blocks).toEqual(blocks);
    // The user message carries no blocks.
    expect(history[0]?.blocks).toBeUndefined();
  });

  it("upserts an assistant turn by messageID without duplicating or re-seq-ing it", async () => {
    const store = await freshStore();
    await insertSession(store, { id: "s1", title: "Build" });
    await appendMessage(store, { sessionId: "s1", role: "user", content: "hi" });

    const first = await persistAssistantMessage(store, {
      sessionId: "s1",
      messageID: "asst_1",
      content: "Working…",
      blocks: [{ kind: "text", partID: "p1", text: "Working…" }],
    });
    expect(first.seq).toBe(1);

    // A second flush of the same turn (e.g. a repeated idle) replaces content/blocks, keeps seq.
    const updatedBlocks: PersistedBlock[] = [
      { kind: "text", partID: "p1", text: "Done: 4 branches." },
    ];
    const second = await persistAssistantMessage(store, {
      sessionId: "s1",
      messageID: "asst_1",
      content: "Done: 4 branches.",
      blocks: updatedBlocks,
    });
    expect(second.id).toBe("asst_1");
    expect(second.seq).toBe(1);
    expect(second.content).toBe("Done: 4 branches.");

    // Exactly one assistant row survives — the upsert did not append a second.
    const history = await listMessages(store, "s1");
    expect(history.filter((m) => m.role === "assistant")).toHaveLength(1);
    expect(history[1]?.blocks).toEqual(updatedBlocks);
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
