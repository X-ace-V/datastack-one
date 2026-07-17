import { describe, expect, it } from "vitest";
import {
  formatSseFrame,
  NormalizedEventSchema,
  NORMALIZED_EVENT_KINDS,
  NORMALIZED_TOOL_STATUSES,
  type NormalizedEvent,
} from "./events.js";

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
