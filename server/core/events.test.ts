import { describe, expect, it } from "vitest";
import {
  formatSseFrame,
  RunProgressPayloadSchema,
  type RunProgressPayload,
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

  it("round-trips a run-progress payload through the data field", () => {
    const payload: RunProgressPayload = {
      runId: "run_1",
      type: "message.part.updated",
      properties: { part: { type: "tool", tool: "profile_source" } },
    };
    const frame = formatSseFrame({ event: payload.type, data: payload });
    const dataLine = frame
      .split("\n")
      .find((l) => l.startsWith("data: "))!
      .slice("data: ".length);
    const parsed = RunProgressPayloadSchema.parse(JSON.parse(dataLine));
    expect(parsed).toEqual(payload);
  });
});
