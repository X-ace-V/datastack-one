import { describe, expect, it } from "vitest";
import type { NormalizedEvent } from "./events.js";
import {
  assistantMessageText,
  blockKey,
  PersistedBlockSchema,
  toPersistedBlock,
} from "./transcript.js";

/**
 * Unit tests for the pure transcript-block contract (V6.2). They assert the exact persisted
 * block a normalized event maps to (so a reopened turn reconstructs what streamed), the stable
 * accumulation key, the text summary, and that non-content events map to null — the invariants
 * the persister and the store round-trip rest on. See LOOP.md §5.
 */
describe("transcript blocks", () => {
  it("maps a text event to a text block keyed by partID", () => {
    const event: NormalizedEvent = {
      kind: "text",
      sessionID: "s",
      messageID: "m",
      partID: "p1",
      text: "hello",
    };
    expect(toPersistedBlock(event)).toEqual({ kind: "text", partID: "p1", text: "hello" });
    expect(blockKey(event)).toBe("text:p1");
  });

  it("maps a reasoning event to a reasoning block", () => {
    const event: NormalizedEvent = {
      kind: "reasoning",
      sessionID: "s",
      messageID: "m",
      partID: "r1",
      text: "thinking",
    };
    expect(toPersistedBlock(event)).toEqual({ kind: "reasoning", partID: "r1", text: "thinking" });
    expect(blockKey(event)).toBe("reasoning:r1");
  });

  it("maps a completed tool event to a tool block keyed by callID, dropping absent fields", () => {
    const event: NormalizedEvent = {
      kind: "tool",
      sessionID: "s",
      messageID: "m",
      partID: "prt",
      callID: "c1",
      tool: "run_query",
      status: "completed",
      input: { sql: "SELECT 1" },
      output: "1 row",
      metadata: { result: { columns: ["n"], rows: [[1]] } },
    };
    const block = toPersistedBlock(event);
    expect(block).toEqual({
      kind: "tool",
      callID: "c1",
      tool: "run_query",
      status: "completed",
      input: { sql: "SELECT 1" },
      output: "1 row",
      metadata: { result: { columns: ["n"], rows: [[1]] } },
    });
    // Absent optionals are omitted, not present-as-undefined, so the persisted JSON stays tight.
    expect(block && "error" in block).toBe(false);
    expect(block && "title" in block).toBe(false);
    expect(blockKey(event)).toBe("tool:c1");
    // Every mapped block validates against the read-back schema.
    expect(PersistedBlockSchema.parse(block)).toEqual(block);
  });

  it("does not persist idle/error/approval events as blocks", () => {
    const nonContent: NormalizedEvent[] = [
      { kind: "idle", sessionID: "s" },
      { kind: "error", sessionID: "s", message: "boom" },
      {
        kind: "approval",
        sessionID: "s",
        requestID: "req_1",
        type: "run_transform",
        metadata: {},
      },
      { kind: "approval_resolved", sessionID: "s", requestID: "req_1", status: "approved" },
    ];
    for (const event of nonContent) {
      expect(toPersistedBlock(event)).toBeNull();
      expect(blockKey(event)).toBeNull();
    }
  });

  it("summarizes an assistant turn as its text blocks joined, ignoring reasoning/tool", () => {
    const text = assistantMessageText([
      { kind: "reasoning", partID: "r", text: "planning" },
      { kind: "text", partID: "a", text: "The north " },
      { kind: "tool", callID: "c", tool: "run_query", status: "completed" },
      { kind: "text", partID: "b", text: "branch." },
    ]);
    expect(text).toBe("The north branch.");
  });
});
