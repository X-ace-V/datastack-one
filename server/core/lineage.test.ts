import { describe, expect, it } from "vitest";
import {
  RunApprovalRecordSchema,
  RunDqResultSchema,
  RunLineageSchema,
  RunToolCallSchema,
  TOOL_CALL_STATUSES,
  parseArgsJson,
} from "./lineage.js";

/**
 * Unit tests for the pure run-lineage contract (T5.5, FR12). The interesting behavior here is
 * {@link parseArgsJson}'s honesty rule — unreadable args must read as "not recorded" (`null`),
 * never as an empty arg map — plus the schemas rejecting records that would misrepresent a run.
 */

describe("TOOL_CALL_STATUSES", () => {
  it("covers the lifecycle a recorded call moves through", () => {
    expect(TOOL_CALL_STATUSES).toEqual(["running", "success", "failed"]);
  });
});

describe("parseArgsJson", () => {
  it("parses a recorded args object back into a record", () => {
    expect(parseArgsJson('{"table":"marts.totals","rows":2}')).toEqual({
      table: "marts.totals",
      rows: 2,
    });
  });

  it("preserves nested structure the UI renders", () => {
    expect(parseArgsJson('{"spec":{"checks":["a","b"]}}')).toEqual({
      spec: { checks: ["a", "b"] },
    });
  });

  it("reads an empty recorded args map as an empty record, not as unrecorded", () => {
    // A tool genuinely called with no args differs from args that were never recorded.
    expect(parseArgsJson("{}")).toEqual({});
  });

  it("reports a NULL column as not recorded", () => {
    expect(parseArgsJson(null)).toBeNull();
  });

  it("reports unparseable text as not recorded rather than throwing", () => {
    expect(parseArgsJson("{not json")).toBeNull();
    expect(parseArgsJson("")).toBeNull();
  });

  it("rejects JSON that is not an args map", () => {
    // A bare scalar/array is not an args record; claiming `{}` for it would invent a fact.
    expect(parseArgsJson('"just a string"')).toBeNull();
    expect(parseArgsJson("[1,2,3]")).toBeNull();
    expect(parseArgsJson("42")).toBeNull();
    expect(parseArgsJson("null")).toBeNull();
  });
});

describe("RunToolCallSchema", () => {
  const base = {
    id: "tc-1",
    runId: "run-1",
    stepId: "step-1",
    tool: "run_transform",
    args: { targetTable: "branch_totals" },
    status: "success",
    result: "materialized 2 rows → marts.branch_totals",
    error: null,
    startedAt: "2026-07-17 10:00:00",
    finishedAt: "2026-07-17 10:00:01",
  };

  it("accepts a completed call", () => {
    expect(RunToolCallSchema.parse(base)).toMatchObject({
      tool: "run_transform",
      status: "success",
    });
  });

  it("accepts a still-running call with no finish time", () => {
    const parsed = RunToolCallSchema.parse({
      ...base,
      status: "running",
      result: null,
      finishedAt: null,
    });
    expect(parsed.finishedAt).toBeNull();
  });

  it("accepts a failed call carrying its error", () => {
    const parsed = RunToolCallSchema.parse({
      ...base,
      status: "failed",
      result: null,
      error: "Table with name source does not exist!",
    });
    expect(parsed.error).toContain("does not exist");
  });

  it("accepts args that were not recorded", () => {
    expect(RunToolCallSchema.parse({ ...base, args: null }).args).toBeNull();
  });

  it("rejects an unknown status", () => {
    expect(() => RunToolCallSchema.parse({ ...base, status: "cancelled" })).toThrow();
  });

  it("rejects a call with no tool name", () => {
    expect(() => RunToolCallSchema.parse({ ...base, tool: "" })).toThrow();
  });

  it("rejects a call not tied to a step, since lineage must attribute it to a stage", () => {
    expect(() => RunToolCallSchema.parse({ ...base, stepId: "" })).toThrow();
  });
});

describe("RunApprovalRecordSchema", () => {
  const base = {
    id: "a-1",
    runId: "run-1",
    requestId: "req-1",
    tool: "land_parquet",
    args: { dataset: "loans" },
    action: "approve",
    createdAt: "2026-07-17 10:00:00",
    decidedAt: "2026-07-17 10:00:00",
  };

  it("accepts an approve decision", () => {
    expect(RunApprovalRecordSchema.parse(base).action).toBe("approve");
  });

  it("accepts a reject decision", () => {
    expect(RunApprovalRecordSchema.parse({ ...base, action: "reject" }).action).toBe("reject");
  });

  it("rejects `always`, which the MVP never records (FR8 needs per-call approval)", () => {
    expect(() => RunApprovalRecordSchema.parse({ ...base, action: "always" })).toThrow();
  });
});

describe("RunDqResultSchema", () => {
  const base = {
    id: "dq-1",
    runId: "run-1",
    checkName: "loan_id not null",
    passed: false,
    detail: "3 NULLs in loan_id",
    createdAt: "2026-07-17 10:00:00",
  };

  it("accepts a failed check with its detail", () => {
    expect(RunDqResultSchema.parse(base)).toMatchObject({ passed: false });
  });

  it("accepts a detail-less result", () => {
    expect(RunDqResultSchema.parse({ ...base, detail: null }).detail).toBeNull();
  });

  it("rejects a non-boolean pass flag, so an ambiguous outcome cannot be recorded", () => {
    expect(() => RunDqResultSchema.parse({ ...base, passed: "false" })).toThrow();
  });

  it("rejects a nameless check", () => {
    expect(() => RunDqResultSchema.parse({ ...base, checkName: "" })).toThrow();
  });
});

describe("RunLineageSchema", () => {
  const run = {
    id: "run-1",
    projectId: "p-1",
    status: "success",
    model: null,
    createdAt: "2026-07-17 10:00:00",
    updatedAt: "2026-07-17 10:00:05",
  };

  it("accepts a run whose records are all empty — a run that did nothing yet", () => {
    const parsed = RunLineageSchema.parse({
      run,
      steps: [],
      toolCalls: [],
      approvals: [],
      dqResults: [],
    });
    expect(parsed.toolCalls).toEqual([]);
    expect(parsed.dqResults).toEqual([]);
  });

  it("rejects lineage with no run to attribute it to", () => {
    expect(() =>
      RunLineageSchema.parse({ steps: [], toolCalls: [], approvals: [], dqResults: [] }),
    ).toThrow();
  });
});
