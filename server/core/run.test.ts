import { describe, expect, it } from "vitest";
import {
  PIPELINE_STAGES,
  RunApprovalRequestSchema,
  RunEventSchema,
  RunSchema,
  RunStartRequestSchema,
  RunStepSchema,
  RUN_STATUSES,
  STEP_STATUSES,
} from "./run.js";

/** Pure-contract tests for the run schemas + the pipeline stage list (T4.4). */
describe("PIPELINE_STAGES", () => {
  it("is the ordered Extract → Land → Load → Transform → DQ pipeline", () => {
    expect(PIPELINE_STAGES.map((s) => s.name)).toEqual([
      "extract",
      "land",
      "load",
      "transform",
      "dq",
    ]);
  });

  it("gates exactly the three write/execute tools, and only those", () => {
    const gated = PIPELINE_STAGES.filter((s) => s.gated);
    expect(gated.map((s) => s.tool)).toEqual([
      "land_parquet",
      "load_warehouse",
      "run_transform",
    ]);
    // Every gated stage names a tool.
    expect(gated.every((s) => s.tool !== null)).toBe(true);
    // The read-only extract stage names no tool and is not gated.
    expect(PIPELINE_STAGES.find((s) => s.name === "extract")!.gated).toBe(false);
    // The DQ stage names a tool (run_dq_check) but is NOT gated — it runs read-only checks; a
    // DQ failure blocks the run rather than pausing for approval (FR7).
    const dq = PIPELINE_STAGES.find((s) => s.name === "dq")!;
    expect(dq.tool).toBe("run_dq_check");
    expect(dq.gated).toBe(false);
  });
});

describe("run schemas", () => {
  it("accepts a valid run and rejects an unknown status", () => {
    const run = {
      id: "r1",
      projectId: "p1",
      status: "running",
      model: null,
      createdAt: "2026-07-17 00:00:00",
      updatedAt: "2026-07-17 00:00:01",
    };
    expect(RunSchema.parse(run)).toEqual(run);
    expect(RUN_STATUSES).toContain("rejected");
    expect(() => RunSchema.parse({ ...run, status: "paused" })).toThrow();
  });

  it("validates a run step's status against the enum", () => {
    const step = {
      id: "s1",
      runId: "r1",
      name: "land",
      ordinal: 1,
      status: "pending",
      detail: null,
      startedAt: null,
      finishedAt: null,
    };
    expect(RunStepSchema.parse(step)).toEqual(step);
    expect(STEP_STATUSES).toContain("skipped");
    expect(() => RunStepSchema.parse({ ...step, ordinal: -1 })).toThrow();
    expect(() => RunStepSchema.parse({ ...step, status: "done" })).toThrow();
  });

  it("defaults the run start request to an empty object", () => {
    expect(RunStartRequestSchema.parse({})).toEqual({});
    expect(RunStartRequestSchema.parse({ sourceId: "s", model: "a/b" })).toEqual({
      sourceId: "s",
      model: "a/b",
    });
    expect(() => RunStartRequestSchema.parse({ sourceId: "" })).toThrow();
  });
});

describe("RunApprovalRequestSchema", () => {
  it("carries the tool, summary, optional SQL, and args", () => {
    const req = {
      requestID: "req1",
      runId: "r1",
      stepId: "s1",
      stepName: "transform",
      tool: "run_transform",
      summary: "Execute the reviewed transform SQL",
      sql: "CREATE TABLE marts.x AS SELECT 1",
      args: { targetTable: "x" },
    };
    expect(RunApprovalRequestSchema.parse(req)).toEqual(req);
    // sql is nullable for the non-SQL tools (land/load).
    expect(RunApprovalRequestSchema.parse({ ...req, sql: null }).sql).toBeNull();
  });
});

describe("RunEventSchema", () => {
  it("discriminates run/step/approval events on `kind`", () => {
    expect(
      RunEventSchema.parse({ kind: "run.status", runId: "r1", status: "success" }).kind,
    ).toBe("run.status");
    expect(
      RunEventSchema.parse({
        kind: "step.status",
        runId: "r1",
        stepId: "s1",
        name: "land",
        status: "running",
        detail: null,
      }).kind,
    ).toBe("step.status");
    expect(
      RunEventSchema.parse({
        kind: "approval.resolved",
        runId: "r1",
        requestID: "req1",
        action: "approve",
      }).kind,
    ).toBe("approval.resolved");
    expect(() => RunEventSchema.parse({ kind: "nope", runId: "r1" })).toThrow();
  });
});
