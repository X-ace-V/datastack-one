import { describe, expect, it } from "vitest";
import { latestQueryResult, readQueryResult, type QueryResult } from "./query";
import type { ChatMessage } from "../store/sessionStore";

/**
 * Unit tests for the data-panel query selectors (V3.3, FR7): reading a `run_query` result out of a
 * tool call's metadata defensively, and finding the latest such result across a transcript.
 */

const RESULT: QueryResult = {
  columns: [
    { name: "branch", type: "VARCHAR" },
    { name: "total", type: "DOUBLE" },
  ],
  rows: [
    { branch: "north", total: 1750.75 },
    { branch: "south", total: 0 },
  ],
  rowCount: 2,
  truncated: false,
};

/** An assistant turn holding a completed run_query tool block carrying `result` in metadata. */
function queryTurn(id: string, result: unknown, tool = "run_query"): ChatMessage {
  return {
    role: "assistant",
    id,
    blocks: [
      {
        kind: "tool",
        callID: `${id}-c`,
        tool,
        status: "completed",
        metadata: result === undefined ? undefined : { result },
      },
    ],
  };
}

describe("readQueryResult", () => {
  it("reads a well-formed result out of metadata", () => {
    expect(readQueryResult({ result: RESULT })).toEqual(RESULT);
  });

  it("returns null when metadata is absent or has no result", () => {
    expect(readQueryResult(undefined)).toBeNull();
    expect(readQueryResult({})).toBeNull();
    expect(readQueryResult({ profile: {} })).toBeNull();
  });

  it("returns null for a malformed result rather than throwing", () => {
    expect(readQueryResult({ result: { columns: "nope", rows: [] } })).toBeNull();
    expect(readQueryResult({ result: { columns: [{ name: "x" }], rows: [] } })).toBeNull();
    expect(
      readQueryResult({ result: { columns: [{ name: "x", type: "INT" }], rows: [{ x: {} }] } }),
    ).toBeNull();
  });

  it("defaults rowCount to the row count and truncated to false when omitted", () => {
    const parsed = readQueryResult({
      result: { columns: [{ name: "x", type: "INT" }], rows: [{ x: 1 }, { x: 2 }] },
    });
    expect(parsed?.rowCount).toBe(2);
    expect(parsed?.truncated).toBe(false);
  });
});

describe("latestQueryResult", () => {
  it("returns null when the transcript has no query result", () => {
    const messages: ChatMessage[] = [
      { role: "user", id: "u1", content: "hi" },
      { role: "assistant", id: "a1", blocks: [{ kind: "text", partID: "p", text: "hello" }] },
    ];
    expect(latestQueryResult(messages)).toBeNull();
  });

  it("returns the most recent run_query result, not an earlier one", () => {
    const older: QueryResult = { ...RESULT, rows: [{ branch: "old", total: 1 }], rowCount: 1 };
    const messages: ChatMessage[] = [
      queryTurn("a1", older),
      { role: "user", id: "u2", content: "and now?" },
      queryTurn("a2", RESULT),
    ];
    expect(latestQueryResult(messages)).toEqual(RESULT);
  });

  it("ignores completed tool calls that are not run_query", () => {
    const messages: ChatMessage[] = [queryTurn("a1", RESULT, "profile_source")];
    expect(latestQueryResult(messages)).toBeNull();
  });

  it("skips a run_query block with no valid result and finds an earlier valid one", () => {
    const messages: ChatMessage[] = [queryTurn("a1", RESULT), queryTurn("a2", undefined)];
    expect(latestQueryResult(messages)).toEqual(RESULT);
  });
});
