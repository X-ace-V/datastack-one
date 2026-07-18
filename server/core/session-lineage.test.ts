import { describe, expect, it } from "vitest";
import {
  LINEAGE_KINDS,
  LINEAGE_STATUSES,
  LineageEventSchema,
  SessionLineageResponseSchema,
  parseLineageDetail,
} from "./session-lineage.js";

/**
 * Pure unit tests for the session lineage contract (V4.4, FR12). Asserts the schema pins the
 * kind/status enums, requires the session/id, allows the nullable run/tool/status/detail, and that
 * the detail parser is defensive — a non-object or unparseable payload becomes `null` rather than
 * crashing an audit read.
 */
describe("session-lineage core", () => {
  const base = {
    id: "l1",
    sessionId: "ses_1",
    runId: null,
    seq: 0,
    kind: "tool_call" as const,
    tool: "land_parquet",
    status: "completed" as const,
    detail: { rowCount: 4 },
    createdAt: "2026-07-18T10:00:00Z",
  };

  it("validates a well-formed tool_call event", () => {
    const parsed = LineageEventSchema.parse(base);
    expect(parsed.kind).toBe("tool_call");
    expect(parsed.status).toBe("completed");
    expect(parsed.detail).toEqual({ rowCount: 4 });
  });

  it("accepts the null run/tool/status/detail (an ad-hoc / kind-less event)", () => {
    const parsed = LineageEventSchema.parse({
      ...base,
      runId: null,
      tool: null,
      status: null,
      detail: null,
    });
    expect(parsed.tool).toBeNull();
    expect(parsed.status).toBeNull();
    expect(parsed.detail).toBeNull();
  });

  it("pins the kind enum", () => {
    expect(LINEAGE_KINDS).toEqual(["tool_call", "approval", "dq_result"]);
    expect(LineageEventSchema.safeParse({ ...base, kind: "reasoning" }).success).toBe(false);
  });

  it("pins the status enum to the closed set of terminal outcomes", () => {
    expect([...LINEAGE_STATUSES].sort()).toEqual(
      ["approved", "completed", "error", "failed", "passed", "rejected"].sort(),
    );
    expect(LineageEventSchema.safeParse({ ...base, status: "running" }).success).toBe(false);
  });

  it("rejects a negative or non-integer seq", () => {
    expect(LineageEventSchema.safeParse({ ...base, seq: -1 }).success).toBe(false);
    expect(LineageEventSchema.safeParse({ ...base, seq: 1.5 }).success).toBe(false);
  });

  it("requires a non-empty sessionId and id", () => {
    expect(LineageEventSchema.safeParse({ ...base, sessionId: "" }).success).toBe(false);
    expect(LineageEventSchema.safeParse({ ...base, id: "" }).success).toBe(false);
  });

  it("validates the response envelope as an array of events", () => {
    const parsed = SessionLineageResponseSchema.parse({ lineage: [base] });
    expect(parsed.lineage).toHaveLength(1);
    expect(SessionLineageResponseSchema.safeParse({ lineage: [{ bogus: true }] }).success).toBe(
      false,
    );
  });

  describe("parseLineageDetail", () => {
    it("parses a JSON object back to a record", () => {
      expect(parseLineageDetail('{"rowCount":4,"table":"marts.x"}')).toEqual({
        rowCount: 4,
        table: "marts.x",
      });
    });

    it("returns null for a SQL NULL detail", () => {
      expect(parseLineageDetail(null)).toBeNull();
    });

    it("returns null for unparseable JSON rather than throwing", () => {
      expect(parseLineageDetail("{not json")).toBeNull();
    });

    it("returns null for a non-object payload (array, string, number)", () => {
      expect(parseLineageDetail("[1,2,3]")).toBeNull();
      expect(parseLineageDetail('"a string"')).toBeNull();
      expect(parseLineageDetail("42")).toBeNull();
      expect(parseLineageDetail("null")).toBeNull();
    });
  });
});
