import { describe, expect, it } from "vitest";
import {
  EventsQuerySchema,
  formatSseFrame,
  NormalizedEventSchema,
  NORMALIZED_EVENT_KINDS,
  NORMALIZED_TOOL_STATUSES,
  parseLastEventId,
  ReplayBuffer,
  type NormalizedEvent,
} from "./events.js";

/** A minimal idle event for the given session — the smallest routable normalized event. */
function idle(sessionID: string): NormalizedEvent {
  return { kind: "idle", sessionID };
}

/**
 * Unit tests for the pure SSE framing (T1.3). These assert the exact wire bytes an
 * `EventSource` client must receive — not merely that the function runs — so a drift in
 * the framing (missing blank-line terminator, unsplit multi-line data, wrong field order)
 * fails here rather than as a silently-broken browser stream.
 */
describe("formatSseFrame", () => {
  it("emits event + data lines terminated by a blank line", () => {
    const frame = formatSseFrame({ event: "session.idle", data: { ok: true } });
    expect(frame).toBe('event: session.idle\ndata: {"ok":true}\n\n');
  });

  it("includes an id line before the event line when given", () => {
    const frame = formatSseFrame({ id: "42", event: "tick", data: 1 });
    expect(frame).toBe("id: 42\nevent: tick\ndata: 1\n\n");
  });

  it("omits event and id lines when they are not provided", () => {
    const frame = formatSseFrame({ data: "hello" });
    expect(frame).toBe('data: "hello"\n\n');
  });

  it("keeps a newline inside a string body on a single data line", () => {
    // JSON escapes an embedded newline to \n, so the framed body stays one physical line
    // and remains a valid single SSE data field.
    expect(formatSseFrame({ data: "line1\nline2" })).toBe(
      'data: "line1\\nline2"\n\n',
    );
  });

  it("frames a null/undefined data as the JSON literal null", () => {
    expect(formatSseFrame({ data: undefined })).toBe("data: null\n\n");
    expect(formatSseFrame({ data: null })).toBe("data: null\n\n");
  });

  it("round-trips a normalized event through the data field", () => {
    const payload: NormalizedEvent = {
      kind: "tool",
      sessionID: "ses_1",
      messageID: "msg_1",
      partID: "prt_1",
      callID: "call_1",
      tool: "profile_source",
      status: "running",
      input: { source: "loans" },
      title: "Profiling loans",
    };
    const frame = formatSseFrame({ event: payload.kind, data: payload });
    const dataLine = frame
      .split("\n")
      .find((l) => l.startsWith("data: "))!
      .slice("data: ".length);
    const parsed = NormalizedEventSchema.parse(JSON.parse(dataLine));
    expect(parsed).toEqual(payload);
  });
});

/**
 * The normalized chat-event contract (V1.4) — the discriminated union `GET /api/events`
 * carries. These assert the union discriminates on `kind` and that each member requires its
 * routing key + payload, so a malformed event fails validation here rather than reaching a
 * browser store that would mis-render it.
 */
describe("NormalizedEventSchema", () => {
  it("enumerates exactly the five chat-event kinds", () => {
    expect([...NORMALIZED_EVENT_KINDS]).toEqual([
      "text",
      "reasoning",
      "tool",
      "idle",
      "error",
    ]);
  });

  it("enumerates OpenCode's native tool statuses", () => {
    expect([...NORMALIZED_TOOL_STATUSES]).toEqual([
      "pending",
      "running",
      "completed",
      "error",
    ]);
  });

  it("accepts each kind with its required fields", () => {
    const text: NormalizedEvent = {
      kind: "text",
      sessionID: "s",
      messageID: "m",
      partID: "p",
      text: "hello",
    };
    const idle: NormalizedEvent = { kind: "idle", sessionID: "s" };
    const err: NormalizedEvent = { kind: "error", sessionID: "s", message: "boom" };
    expect(NormalizedEventSchema.parse(text)).toEqual(text);
    expect(NormalizedEventSchema.parse(idle)).toEqual(idle);
    expect(NormalizedEventSchema.parse(err)).toEqual(err);
  });

  it("requires a non-empty sessionID on every kind (the routing key)", () => {
    expect(NormalizedEventSchema.safeParse({ kind: "idle", sessionID: "" }).success).toBe(
      false,
    );
  });

  it("rejects a tool event with an unknown status", () => {
    expect(
      NormalizedEventSchema.safeParse({
        kind: "tool",
        sessionID: "s",
        messageID: "m",
        partID: "p",
        callID: "c",
        tool: "run_query",
        status: "queued",
      }).success,
    ).toBe(false);
  });

  it("rejects an unknown kind", () => {
    expect(
      NormalizedEventSchema.safeParse({ kind: "status", sessionID: "s" }).success,
    ).toBe(false);
  });
});

/**
 * The monotonic-sequence replay buffer backing `GET /api/events` reconnect (V1.5, FR3). These
 * assert the sequencing, the per-session scoping of replay, and the bounded retention — the
 * exact invariants the SSE route's no-gap/no-duplicate resume rests on.
 */
describe("ReplayBuffer", () => {
  it("assigns strictly increasing seqs starting at 1", () => {
    const buffer = new ReplayBuffer();
    expect(buffer.lastSeq).toBe(0);
    expect(buffer.append(idle("s1"))).toEqual({ seq: 1, event: idle("s1") });
    expect(buffer.append(idle("s2"))).toEqual({ seq: 2, event: idle("s2") });
    expect(buffer.lastSeq).toBe(2);
  });

  it("replays only events after the given seq, in order", () => {
    const buffer = new ReplayBuffer();
    buffer.append(idle("s1")); // seq 1
    buffer.append(idle("s1")); // seq 2
    buffer.append(idle("s1")); // seq 3
    expect(buffer.replay(0).map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(buffer.replay(1).map((e) => e.seq)).toEqual([2, 3]);
    expect(buffer.replay(3)).toEqual([]);
  });

  it("scopes replay to one session when a sessionId is given", () => {
    const buffer = new ReplayBuffer();
    buffer.append(idle("s1")); // seq 1
    buffer.append(idle("s2")); // seq 2
    buffer.append(idle("s1")); // seq 3
    expect(buffer.replay(0, "s1").map((e) => e.seq)).toEqual([1, 3]);
    expect(buffer.replay(0, "s2").map((e) => e.seq)).toEqual([2]);
    // Cross the session filter with the seq cursor: only s1 events after seq 1.
    expect(buffer.replay(1, "s1").map((e) => e.seq)).toEqual([3]);
  });

  it("retains only the most recent `capacity` events, dropping the oldest", () => {
    const buffer = new ReplayBuffer(3);
    for (let i = 0; i < 5; i += 1) buffer.append(idle("s1")); // seqs 1..5
    // seqs 1 and 2 are evicted; seq keeps counting past the window.
    expect(buffer.lastSeq).toBe(5);
    expect(buffer.replay(0).map((e) => e.seq)).toEqual([3, 4, 5]);
  });

  it("cannot resurrect an event older than the retained window", () => {
    const buffer = new ReplayBuffer(2);
    for (let i = 0; i < 4; i += 1) buffer.append(idle("s1")); // seqs 1..4, retains 3,4
    // A client that last saw seq 1 asks for >1, but 2 is gone — it gets only what survives.
    expect(buffer.replay(1).map((e) => e.seq)).toEqual([3, 4]);
  });
});

describe("EventsQuerySchema", () => {
  it("coerces lastSeq from its string query form and keeps sessionId", () => {
    expect(EventsQuerySchema.parse({ sessionId: "ses_1", lastSeq: "42" })).toEqual({
      sessionId: "ses_1",
      lastSeq: 42,
    });
  });

  it("accepts an empty query (both fields optional)", () => {
    expect(EventsQuerySchema.parse({})).toEqual({});
  });

  it("rejects a negative or non-integer lastSeq", () => {
    expect(EventsQuerySchema.safeParse({ lastSeq: "-1" }).success).toBe(false);
    expect(EventsQuerySchema.safeParse({ lastSeq: "3.5" }).success).toBe(false);
    expect(EventsQuerySchema.safeParse({ lastSeq: "abc" }).success).toBe(false);
  });

  it("rejects an empty sessionId", () => {
    expect(EventsQuerySchema.safeParse({ sessionId: "" }).success).toBe(false);
  });
});

describe("parseLastEventId", () => {
  it("parses a non-negative integer header into a resume cursor", () => {
    expect(parseLastEventId("0")).toBe(0);
    expect(parseLastEventId("7")).toBe(7);
  });

  it("returns undefined for a missing or malformed header", () => {
    expect(parseLastEventId(undefined)).toBeUndefined();
    expect(parseLastEventId("-1")).toBeUndefined();
    expect(parseLastEventId("1.5")).toBeUndefined();
    expect(parseLastEventId("abc")).toBeUndefined();
    expect(parseLastEventId("")).toBeUndefined();
  });
});
