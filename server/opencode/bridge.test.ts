import { describe, expect, it } from "vitest";
import type { Event } from "@opencode-ai/sdk";
import {
  createEventBridge,
  normalizeEvent,
  type EventClient,
} from "./bridge.js";
import { NormalizedEventSchema } from "../core/events.js";

/**
 * Unit tests for the OpenCode → normalized chat-event bridge (V1.4). The mapping
 * ({@link normalizeEvent}) is tested exhaustively — every relayed part type, idle, error,
 * and each dropped case — asserting the exact normalized event, because the browser store
 * (V2.1) switches on it. The pump ({@link createEventBridge}) is driven by a hand-built
 * event stream (no `opencode` subprocess) to assert fan-out, raw-event observation, and
 * clean shutdown. See LOOP.md §5 — assert values and invariants, not just "it ran".
 */

/** A controllable raw-event stream wrapped by the mock as OpenCode global events. */
function makeEventStream() {
  const queue: Event[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  async function* gen(): AsyncGenerator<Event> {
    while (true) {
      if (queue.length > 0) {
        yield queue.shift()!;
        continue;
      }
      if (done) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  }
  return {
    stream: gen(),
    push(event: Event) {
      queue.push(event);
      wake?.();
      wake = null;
    },
    end() {
      done = true;
      wake?.();
      wake = null;
    },
  };
}

/** Build an `EventClient` whose cross-directory `global.event()` wraps the given stream. */
function mockClient(stream: AsyncGenerator<Event>): EventClient {
  async function* globalStream() {
    for await (const payload of stream) {
      yield { directory: "/workspace", payload };
    }
  }
  return {
    global: { event: async () => ({ stream: globalStream() }) },
  } as unknown as EventClient;
}

/** Yield to the pump so a pushed event is dispatched before assertions run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A `message.part.updated` event carrying the given part. */
function partEvent(part: unknown): Event {
  return {
    type: "message.part.updated",
    properties: { part },
  } as unknown as Event;
}

/**
 * A `permission.asked` event (a write tool asking for approval), carrying its `sql` metadata.
 * The shape mirrors the live opencode v2 runtime contract verified in the V1.6 smoke: the
 * permission id under `id`, the gated surface under `permission`, args under `metadata`, and a
 * tool-originated call's `callID` nested under `tool`.
 */
function askedEvent(requestID: string, sessionID: string): Event {
  return {
    type: "permission.asked",
    properties: {
      id: requestID,
      sessionID,
      permission: "run_transform",
      patterns: ["marts.report"],
      metadata: { sql: "CREATE TABLE marts.report AS SELECT 1" },
      always: [],
      tool: { messageID: "msg_1", callID: "call_1" },
    },
  } as unknown as Event;
}

/** A `permission.replied` event (v2 contract: `requestID` + `reply`), as the runtime emits it. */
function repliedEvent(requestID: string, sessionID: string, reply: string): Event {
  return {
    type: "permission.replied",
    properties: { sessionID, requestID, reply },
  } as unknown as Event;
}

function questionAskedEvent(type = "question.asked"): Event {
  return {
    type,
    properties: {
      id: "question_1",
      sessionID: "ses_1",
      questions: [{
        header: "Warehouse",
        question: "Which warehouse?",
        options: [{ label: "DuckDB", description: "Local" }],
      }],
      tool: { messageID: "msg_1", callID: "call_question" },
    },
  } as unknown as Event;
}

describe("normalizeEvent", () => {
  it("maps a text part to a text event keyed by session/message/part", () => {
    const event = partEvent({
      id: "prt_1",
      sessionID: "ses_1",
      messageID: "msg_1",
      type: "text",
      text: "hello world",
    });
    expect(normalizeEvent(event)).toEqual({
      kind: "text",
      sessionID: "ses_1",
      messageID: "msg_1",
      partID: "prt_1",
      text: "hello world",
    });
  });

  it("drops a synthetic text part (runtime-injected, not streamed output)", () => {
    const event = partEvent({
      id: "prt_s",
      sessionID: "ses_1",
      messageID: "msg_1",
      type: "text",
      text: "injected",
      synthetic: true,
    });
    expect(normalizeEvent(event)).toBeNull();
  });

  it("maps a reasoning part to a reasoning event", () => {
    const event = partEvent({
      id: "prt_r",
      sessionID: "ses_1",
      messageID: "msg_1",
      type: "reasoning",
      text: "let me think",
    });
    expect(normalizeEvent(event)).toEqual({
      kind: "reasoning",
      sessionID: "ses_1",
      messageID: "msg_1",
      partID: "prt_r",
      text: "let me think",
    });
  });

  it("maps a running tool part with its input and title, no output/error", () => {
    const event = partEvent({
      id: "prt_t",
      sessionID: "ses_1",
      messageID: "msg_1",
      type: "tool",
      callID: "call_1",
      tool: "profile_source",
      state: { status: "running", input: { source: "loans" }, title: "Profiling", time: { start: 1 } },
    });
    expect(normalizeEvent(event)).toEqual({
      kind: "tool",
      sessionID: "ses_1",
      messageID: "msg_1",
      partID: "prt_t",
      callID: "call_1",
      tool: "profile_source",
      status: "running",
      input: { source: "loans" },
      output: undefined,
      error: undefined,
      title: "Profiling",
    });
  });

  it("maps a completed tool part carrying the output", () => {
    const event = partEvent({
      id: "prt_t",
      sessionID: "ses_1",
      messageID: "msg_1",
      type: "tool",
      callID: "call_1",
      tool: "run_query",
      state: {
        status: "completed",
        input: { sql: "SELECT 1" },
        output: "1 row",
        title: "Query",
        metadata: {},
        time: { start: 1, end: 2 },
      },
    });
    const normalized = normalizeEvent(event);
    expect(normalized).toMatchObject({ kind: "tool", status: "completed", output: "1 row" });
    expect((normalized as { error?: string }).error).toBeUndefined();
  });

  it("carries a completed tool's structured metadata (the data-panel payload, FR7)", () => {
    const result = {
      columns: [{ name: "branch", type: "VARCHAR" }],
      rows: [{ branch: "north" }],
      rowCount: 1,
      truncated: false,
    };
    const event = partEvent({
      id: "prt_q",
      sessionID: "ses_1",
      messageID: "msg_1",
      type: "tool",
      callID: "call_q",
      tool: "run_query",
      state: {
        status: "completed",
        input: { sql: "SELECT branch FROM loans" },
        output: "1 row",
        title: "1 row",
        metadata: { result },
        time: { start: 1, end: 2 },
      },
    });
    const normalized = normalizeEvent(event);
    expect((normalized as { metadata?: unknown }).metadata).toEqual({ result });
  });

  it("maps an errored tool part carrying the error detail", () => {
    const event = partEvent({
      id: "prt_t",
      sessionID: "ses_1",
      messageID: "msg_1",
      type: "tool",
      callID: "call_1",
      tool: "run_query",
      state: { status: "error", input: {}, error: "boom", time: { start: 1, end: 2 } },
    });
    const normalized = normalizeEvent(event);
    expect(normalized).toMatchObject({ kind: "tool", status: "error", error: "boom" });
    expect((normalized as { output?: string }).output).toBeUndefined();
  });

  it("drops a non-chat part type (step-finish, file, snapshot, …)", () => {
    const event = partEvent({
      id: "prt_x",
      sessionID: "ses_1",
      messageID: "msg_1",
      type: "step-finish",
      reason: "stop",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    });
    expect(normalizeEvent(event)).toBeNull();
  });

  it("maps session.idle to an idle event", () => {
    const event = { type: "session.idle", properties: { sessionID: "ses_9" } } as unknown as Event;
    expect(normalizeEvent(event)).toEqual({ kind: "idle", sessionID: "ses_9" });
  });

  it("maps session.error to an error event, extracting the message", () => {
    const event = {
      type: "session.error",
      properties: {
        sessionID: "ses_9",
        error: { name: "UnknownError", data: { message: "provider exploded" } },
      },
    } as unknown as Event;
    expect(normalizeEvent(event)).toEqual({
      kind: "error",
      sessionID: "ses_9",
      message: "provider exploded",
    });
  });

  it("falls back to the error name when the payload carries no message", () => {
    const event = {
      type: "session.error",
      properties: { sessionID: "ses_9", error: { name: "MessageOutputLengthError", data: {} } },
    } as unknown as Event;
    expect(normalizeEvent(event)).toEqual({
      kind: "error",
      sessionID: "ses_9",
      message: "MessageOutputLengthError",
    });
  });

  it("drops a session.error with no session id (cannot be routed)", () => {
    const event = { type: "session.error", properties: {} } as unknown as Event;
    expect(normalizeEvent(event)).toBeNull();
  });

  it("maps permission.asked to an inline approval carrying the SQL metadata (FR10)", () => {
    expect(normalizeEvent(askedEvent("perm_1", "ses_1"))).toEqual({
      kind: "approval",
      sessionID: "ses_1",
      requestID: "perm_1",
      type: "run_transform",
      callID: "call_1",
      patterns: ["marts.report"],
      metadata: { sql: "CREATE TABLE marts.report AS SELECT 1" },
    });
  });

  it("maps permission.replied 'once'/'always' to an approved resolution", () => {
    for (const reply of ["once", "always"]) {
      expect(normalizeEvent(repliedEvent("perm_1", "ses_1", reply))).toEqual({
        kind: "approval_resolved",
        sessionID: "ses_1",
        requestID: "perm_1",
        status: "approved",
      });
    }
  });

  it("maps permission.replied 'reject' to a rejected resolution", () => {
    expect(normalizeEvent(repliedEvent("perm_2", "ses_1", "reject"))).toEqual({
      kind: "approval_resolved",
      sessionID: "ses_1",
      requestID: "perm_2",
      status: "rejected",
    });
  });

  it.each(["question.asked", "question.v2.asked"])(
    "maps %s to an inline interactive question",
    (type) => {
      expect(normalizeEvent(questionAskedEvent(type))).toEqual({
        kind: "question",
        requestID: "question_1",
        sessionID: "ses_1",
        questions: [{
          header: "Warehouse",
          question: "Which warehouse?",
          options: [{ label: "DuckDB", description: "Local" }],
        }],
        messageID: "msg_1",
        callID: "call_question",
      });
    },
  );

  it("maps answered and rejected question events to terminal resolutions", () => {
    expect(normalizeEvent({
      type: "question.replied",
      properties: { sessionID: "ses_1", requestID: "question_1", answers: [["DuckDB"]] },
    } as unknown as Event)).toEqual({
      kind: "question_resolved",
      sessionID: "ses_1",
      requestID: "question_1",
      status: "answered",
      answers: [["DuckDB"]],
    });
    expect(normalizeEvent({
      type: "question.v2.rejected",
      properties: { sessionID: "ses_1", requestID: "question_1" },
    } as unknown as Event)).toEqual({
      kind: "question_resolved",
      sessionID: "ses_1",
      requestID: "question_1",
      status: "rejected",
    });
  });

  it("drops unsupported or malformed non-chat event types", () => {
    for (const type of ["session.status", "message.updated", "server.connected", "file.watcher.updated"]) {
      const event = { type, properties: { sessionID: "ses_1" } } as unknown as Event;
      expect(normalizeEvent(event)).toBeNull();
    }
  });

  it("maps OpenCode-native title and background status updates", () => {
    expect(normalizeEvent({
      type: "session.updated",
      properties: { info: { id: "ses_1", title: "Profile loan defaults" } },
    } as unknown as Event)).toEqual({
      kind: "session_updated",
      sessionID: "ses_1",
      title: "Profile loan defaults",
    });
    expect(normalizeEvent({
      type: "session.status",
      properties: { sessionID: "ses_1", status: { type: "busy" } },
    } as unknown as Event)).toEqual({
      kind: "session_status",
      sessionID: "ses_1",
      status: "busy",
    });
  });

  it("produces schema-valid events for every relayed kind", () => {
    const cases: Event[] = [
      partEvent({ id: "p", sessionID: "s", messageID: "m", type: "text", text: "hi" }),
      partEvent({ id: "p", sessionID: "s", messageID: "m", type: "reasoning", text: "hmm" }),
      partEvent({
        id: "p",
        sessionID: "s",
        messageID: "m",
        type: "tool",
        callID: "c",
        tool: "list_sources",
        state: { status: "pending", input: {}, raw: "" },
      }),
      { type: "session.idle", properties: { sessionID: "s" } } as unknown as Event,
      {
        type: "session.error",
        properties: { sessionID: "s", error: { name: "UnknownError", data: { message: "x" } } },
      } as unknown as Event,
      askedEvent("perm_1", "s"),
      repliedEvent("perm_1", "s", "once"),
      questionAskedEvent(),
      {
        type: "question.replied",
        properties: { sessionID: "s", requestID: "question_1", answers: [["DuckDB"]] },
      } as unknown as Event,
      {
        type: "session.updated",
        properties: { info: { id: "s", title: "Native title" } },
      } as unknown as Event,
      {
        type: "session.status",
        properties: { sessionID: "s", status: { type: "busy" } },
      } as unknown as Event,
    ];
    for (const event of cases) {
      const normalized = normalizeEvent(event);
      expect(normalized).not.toBeNull();
      expect(NormalizedEventSchema.parse(normalized)).toEqual(normalized);
    }
  });
});

describe("createEventBridge", () => {
  it("fans a normalized event to every subscriber", async () => {
    const src = makeEventStream();
    const bridge = createEventBridge(mockClient(src.stream));
    const a: unknown[] = [];
    const b: unknown[] = [];
    bridge.subscribe((e) => a.push(e));
    bridge.subscribe((e) => b.push(e));

    src.push({ type: "session.idle", properties: { sessionID: "ses_A" } } as unknown as Event);
    await flush();

    expect(a).toEqual([{ kind: "idle", sessionID: "ses_A" }]);
    expect(b).toEqual([{ kind: "idle", sessionID: "ses_A" }]);
    await bridge.close();
  });

  it("does not deliver dropped (non-chat) events to subscribers", async () => {
    const src = makeEventStream();
    const bridge = createEventBridge(mockClient(src.stream));
    const seen: unknown[] = [];
    bridge.subscribe((e) => seen.push(e));

    src.push({ type: "message.updated", properties: { sessionID: "ses_A" } } as unknown as Event);
    src.push({ type: "server.connected", properties: {} } as unknown as Event);
    await flush();

    expect(seen).toEqual([]);
    await bridge.close();
  });

  it("delivers a permission.asked to subscribers as an inline approval (SSE seam, FR10)", async () => {
    const src = makeEventStream();
    const bridge = createEventBridge(mockClient(src.stream));
    const seen: unknown[] = [];
    bridge.subscribe((e) => seen.push(e));

    src.push(askedEvent("perm_1", "ses_A"));
    src.push(repliedEvent("perm_1", "ses_A", "once"));
    await flush();

    // The paused write tool and its resolution both ride the normalized chat stream.
    expect(seen).toEqual([
      {
        kind: "approval",
        sessionID: "ses_A",
        requestID: "perm_1",
        type: "run_transform",
        callID: "call_1",
        patterns: ["marts.report"],
        metadata: { sql: "CREATE TABLE marts.report AS SELECT 1" },
      },
      {
        kind: "approval_resolved",
        sessionID: "ses_A",
        requestID: "perm_1",
        status: "approved",
      },
    ]);
    await bridge.close();
  });

  it("delivers a question and its answer over the normalized stream", async () => {
    const src = makeEventStream();
    const bridge = createEventBridge(mockClient(src.stream));
    const seen: unknown[] = [];
    bridge.subscribe((event) => seen.push(event));
    src.push(questionAskedEvent());
    src.push({
      type: "question.replied",
      properties: { sessionID: "ses_1", requestID: "question_1", answers: [["DuckDB"]] },
    } as unknown as Event);
    await flush();
    expect(seen.map((event) => (event as { kind: string }).kind)).toEqual([
      "question",
      "question_resolved",
    ]);
    await bridge.close();
  });

  it("passes the global event directory to raw interaction observers", async () => {
    const src = makeEventStream();
    const raw: Array<{ event: Event; directory: string }> = [];
    const bridge = createEventBridge(mockClient(src.stream), {
      onRawEvent: (event, context) => raw.push({ event, directory: context.directory }),
    });
    src.push(questionAskedEvent());
    await flush();
    expect(raw).toEqual([{ event: questionAskedEvent(), directory: "/workspace" }]);
    await bridge.close();
  });

  it("stops delivering to a listener after it unsubscribes", async () => {
    const src = makeEventStream();
    const bridge = createEventBridge(mockClient(src.stream));
    const seen: unknown[] = [];
    const unsubscribe = bridge.subscribe((e) => seen.push(e));

    src.push({ type: "session.idle", properties: { sessionID: "ses_A" } } as unknown as Event);
    await flush();
    expect(seen).toHaveLength(1);

    unsubscribe();
    src.push({ type: "session.idle", properties: { sessionID: "ses_A" } } as unknown as Event);
    await flush();
    expect(seen).toHaveLength(1);

    await bridge.close();
  });

  it("observes every raw event via onRawEvent, including dropped ones", async () => {
    const src = makeEventStream();
    const raw: string[] = [];
    const normalized: unknown[] = [];
    const bridge = createEventBridge(mockClient(src.stream), {
      onRawEvent: (e) => raw.push(e.type),
    });
    bridge.subscribe((e) => normalized.push(e));

    src.push({ type: "message.updated", properties: { sessionID: "ses_A" } } as unknown as Event);
    src.push({ type: "session.idle", properties: { sessionID: "ses_A" } } as unknown as Event);
    await flush();

    // Raw pump sees BOTH (the message envelope carries role, read elsewhere); only idle is chat.
    expect(raw).toEqual(["message.updated", "session.idle"]);
    expect(normalized).toEqual([{ kind: "idle", sessionID: "ses_A" }]);
    await bridge.close();
  });

  it("close() is idempotent and does not report an error on abort", async () => {
    const src = makeEventStream();
    let errored = false;
    const bridge = createEventBridge(mockClient(src.stream), {
      onError: () => {
        errored = true;
      },
    });
    await bridge.close();
    await bridge.close();
    await flush();
    expect(errored).toBe(false);
  });
});
