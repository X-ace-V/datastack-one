import { afterEach, describe, expect, it } from "vitest";
import type { Event } from "@opencode-ai/sdk";
import { openStore, type WarehouseStore } from "../store/duckdb.js";
import { insertSession, appendMessage, listMessages } from "../store/sessions.js";
import { createTranscriptPersister } from "./transcript.js";

/**
 * Integration tests for the transcript persister (V6.2, FR1) against a REAL in-memory warehouse.
 * They drive the exact raw events the runtime emits — `message.updated` (role), a stream of
 * `message.part.updated` (text/reasoning/tool blocks), and `session.idle` (flush) — and assert
 * that reopening the session via `listMessages` reconstructs the assistant turn WITH its ordered
 * tool-block history, that the user's own prompt echo is not persisted a second time, and that a
 * repeated idle does not duplicate the row. See LOOP.md §5 — assert the reconstructed values.
 */

/** A `message.updated` event announcing a message's role. */
function roleEvent(id: string, role: "user" | "assistant", sessionID: string): Event {
  return {
    type: "message.updated",
    properties: { info: { id, role, sessionID } },
  } as unknown as Event;
}

/** A `message.part.updated` event carrying one streamed part. */
function partEvent(part: unknown): Event {
  return { type: "message.part.updated", properties: { part } } as unknown as Event;
}

/** A `session.idle` event ending a turn. */
function idleEvent(sessionID: string): Event {
  return { type: "session.idle", properties: { sessionID } } as unknown as Event;
}

describe("transcript persister", () => {
  const open: WarehouseStore[] = [];

  afterEach(async () => {
    await Promise.all(open.splice(0).map((s) => s.close()));
  });

  async function freshStore(): Promise<WarehouseStore> {
    const store = await openStore(":memory:");
    open.push(store);
    return store;
  }

  it("persists an assistant turn's ordered blocks on idle and reconstructs them on reopen", async () => {
    const store = await freshStore();
    await insertSession(store, { id: "ses_1", title: "Build" });
    // The chat turn persists the user's prompt before the turn runs.
    await appendMessage(store, { sessionId: "ses_1", role: "user", content: "which branch?" });

    const persister = createTranscriptPersister(store, {
      onError: (e) => {
        throw e;
      },
    });

    // The runtime announces both messages' roles, then streams the assistant's parts. It also
    // re-streams the user's own prompt as a role-less text part under the user message id.
    persister.ingest(roleEvent("usr_1", "user", "ses_1"));
    persister.ingest(roleEvent("asst_1", "assistant", "ses_1"));
    persister.ingest(
      partEvent({ id: "up", sessionID: "ses_1", messageID: "usr_1", type: "text", text: "which branch?" }),
    );
    persister.ingest(
      partEvent({ id: "r1", sessionID: "ses_1", messageID: "asst_1", type: "reasoning", text: "I'll query it." }),
    );
    // The tool call streams pending → completed under the same callID; the later state wins.
    persister.ingest(
      partEvent({
        id: "t1",
        sessionID: "ses_1",
        messageID: "asst_1",
        type: "tool",
        callID: "c1",
        tool: "run_query",
        state: { status: "pending", input: {} },
      }),
    );
    persister.ingest(
      partEvent({
        id: "t1",
        sessionID: "ses_1",
        messageID: "asst_1",
        type: "tool",
        callID: "c1",
        tool: "run_query",
        state: {
          status: "completed",
          input: { sql: "SELECT branch FROM loans" },
          output: "north",
          title: "1 row",
          metadata: { result: { columns: ["branch"], rows: [["north"]] } },
          time: { start: 1, end: 2 },
        },
      }),
    );
    persister.ingest(
      partEvent({ id: "p1", sessionID: "ses_1", messageID: "asst_1", type: "text", text: "The north branch." }),
    );

    // Nothing is persisted until the turn goes idle.
    expect((await listMessages(store, "ses_1")).filter((m) => m.role === "assistant")).toHaveLength(0);

    await persister.flush("ses_1");

    const history = await listMessages(store, "ses_1");
    // The user prompt is not duplicated by its echo; exactly one assistant turn is added, after it.
    expect(history.map((m) => [m.seq, m.role])).toEqual([
      [0, "user"],
      [1, "assistant"],
    ]);
    const assistant = history[1]!;
    expect(assistant.id).toBe("asst_1");
    // Blocks reconstruct in reading order, the tool card settled to `completed` with its payload.
    expect(assistant.blocks).toEqual([
      { kind: "reasoning", partID: "r1", text: "I'll query it." },
      {
        kind: "tool",
        callID: "c1",
        tool: "run_query",
        status: "completed",
        input: { sql: "SELECT branch FROM loans" },
        output: "north",
        title: "1 row",
        metadata: { result: { columns: ["branch"], rows: [["north"]] } },
      },
      { kind: "text", partID: "p1", text: "The north branch." },
    ]);
    // The text-only fallback content is the joined text blocks.
    expect(assistant.content).toBe("The north branch.");
  });

  it("skips a message whose role never arrived, and does not double-insert on a repeated idle", async () => {
    const store = await freshStore();
    await insertSession(store, { id: "ses_1", title: "Build" });
    const persister = createTranscriptPersister(store);

    // An assistant turn with a known role, plus a message whose role is never announced.
    persister.ingest(roleEvent("asst_1", "assistant", "ses_1"));
    persister.ingest(
      partEvent({ id: "p1", sessionID: "ses_1", messageID: "asst_1", type: "text", text: "hi" }),
    );
    persister.ingest(
      partEvent({ id: "p2", sessionID: "ses_1", messageID: "orphan", type: "text", text: "??" }),
    );

    await persister.flush("ses_1");
    await persister.flush("ses_1"); // a repeated idle must not append a second row

    const assistants = (await listMessages(store, "ses_1")).filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(1);
    expect(assistants[0]?.id).toBe("asst_1");
    // The unattributed "orphan" message was not persisted.
    expect(assistants.some((m) => m.id === "orphan")).toBe(false);
  });

  it("ingest triggers a flush on idle, persisting without an explicit flush() call", async () => {
    const store = await freshStore();
    await insertSession(store, { id: "ses_1", title: "Build" });
    const errors: unknown[] = [];
    const persister = createTranscriptPersister(store, { onError: (e) => errors.push(e) });

    persister.ingest(roleEvent("asst_1", "assistant", "ses_1"));
    persister.ingest(
      partEvent({ id: "p1", sessionID: "ses_1", messageID: "asst_1", type: "text", text: "done" }),
    );
    persister.ingest(idleEvent("ses_1"));

    // The idle-triggered flush is fire-and-forget; give its microtask a tick to settle.
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(errors).toEqual([]);
    const assistants = (await listMessages(store, "ses_1")).filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(1);
    expect(assistants[0]?.content).toBe("done");
  });
});
