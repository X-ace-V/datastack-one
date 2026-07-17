import { afterEach, describe, expect, it } from "vitest";
import { openStore, type WarehouseStore } from "./duckdb.js";
import { createRun, insertRunStep, recordApproval } from "./runs.js";
import {
  completeToolCall,
  getRunLineage,
  listRunApprovals,
  listRunDqResults,
  listRunToolCalls,
  recordDqResults,
  startToolCall,
} from "./lineage.js";
import type { DqCheckResult } from "../core/dq.js";

/**
 * Persistence tests for the run-lineage record (T5.5, FR12) on a real DuckDB store: tool calls,
 * DQ results, the approval trail, and the assembled lineage. These assert the recorded VALUES —
 * a lineage that reads back wrong is worse than none, since it would be trusted.
 */
describe("lineage store", () => {
  const open: WarehouseStore[] = [];

  afterEach(async () => {
    await Promise.all(open.splice(0).map((s) => s.close()));
  });

  /** A store with a project, a run, and one step to hang tool calls off. */
  async function fresh(): Promise<WarehouseStore> {
    const store = await openStore(":memory:");
    open.push(store);
    await store.run(
      `INSERT INTO platform.projects (id, name, domain) VALUES ('p1', 'Loans', 'lending')`,
    );
    await createRun(store, { id: "r1", projectId: "p1" });
    await insertRunStep(store, { id: "s1", runId: "r1", name: "land", ordinal: 0 });
    await insertRunStep(store, { id: "s2", runId: "r1", name: "dq", ordinal: 1 });
    return store;
  }

  function dqResult(over: Partial<DqCheckResult> & { id: string }): DqCheckResult & { id: string } {
    return {
      name: "row count is positive",
      type: "row_count",
      column: null,
      passed: true,
      detail: "3 rows",
      ...over,
    };
  }

  it("opens a tool call as running before the tool executes", async () => {
    const store = await fresh();
    const call = await startToolCall(store, {
      id: "tc1",
      runId: "r1",
      stepId: "s1",
      tool: "land_parquet",
      args: { dataset: "loans", ingestionDate: "2026-07-17" },
    });

    // Written before execution, so a call that dies mid-flight still leaves this trace.
    expect(call.status).toBe("running");
    expect(call.tool).toBe("land_parquet");
    expect(call.args).toEqual({ dataset: "loans", ingestionDate: "2026-07-17" });
    expect(call.result).toBeNull();
    expect(call.error).toBeNull();
    expect(call.finishedAt).toBeNull();
    expect(typeof call.startedAt).toBe("string");
  });

  it("closes a tool call with its success outcome", async () => {
    const store = await fresh();
    await startToolCall(store, {
      id: "tc1",
      runId: "r1",
      stepId: "s1",
      tool: "land_parquet",
      args: {},
    });
    await completeToolCall(store, "tc1", "success", { result: "landed 3 rows" });

    const [call] = await listRunToolCalls(store, "r1");
    expect(call?.status).toBe("success");
    expect(call?.result).toBe("landed 3 rows");
    expect(call?.error).toBeNull();
    expect(call?.finishedAt).not.toBeNull();
  });

  it("closes a failed tool call with its error and no result", async () => {
    const store = await fresh();
    await startToolCall(store, {
      id: "tc1",
      runId: "r1",
      stepId: "s1",
      tool: "load_warehouse",
      args: { landingPath: "/tmp/nope" },
    });
    await completeToolCall(store, "tc1", "failed", { error: "IO Error: no files found" });

    const [call] = await listRunToolCalls(store, "r1");
    expect(call?.status).toBe("failed");
    expect(call?.error).toBe("IO Error: no files found");
    // The row stays unambiguous about which way the call went.
    expect(call?.result).toBeNull();
  });

  it("lists a run's tool calls oldest first and scopes them to that run", async () => {
    const store = await fresh();
    await createRun(store, { id: "r2", projectId: "p1" });
    await insertRunStep(store, { id: "s3", runId: "r2", name: "land", ordinal: 0 });

    await startToolCall(store, { id: "tc1", runId: "r1", stepId: "s1", tool: "land_parquet", args: {} });
    await startToolCall(store, { id: "tc2", runId: "r1", stepId: "s1", tool: "load_warehouse", args: {} });
    await startToolCall(store, { id: "tc3", runId: "r2", stepId: "s3", tool: "land_parquet", args: {} });

    expect((await listRunToolCalls(store, "r1")).map((c) => c.tool)).toEqual([
      "land_parquet",
      "load_warehouse",
    ]);
    // Another run's calls never leak into this run's lineage.
    expect((await listRunToolCalls(store, "r2")).map((c) => c.id)).toEqual(["tc3"]);
    expect(await listRunToolCalls(store, "missing")).toEqual([]);
  });

  it("stores an injection-shaped arg value literally rather than executing it", async () => {
    const store = await fresh();
    const payload = `'; DROP TABLE platform.runs; --`;
    await startToolCall(store, {
      id: "tc1",
      runId: "r1",
      stepId: "s1",
      tool: "run_transform",
      args: { targetTable: payload },
    });

    const [call] = await listRunToolCalls(store, "r1");
    expect(call?.args).toEqual({ targetTable: payload });
    // The runs table is intact — the payload was bound as a value, never concatenated.
    expect((await store.all(`SELECT count(*) AS n FROM platform.runs`))[0]?.n).toBe(1n);
  });

  it("records every DQ check outcome, passing and failing", async () => {
    const store = await fresh();
    await recordDqResults(store, "r1", [
      dqResult({ id: "d1", name: "row count is positive", passed: true, detail: "3 rows" }),
      dqResult({ id: "d2", name: "loan_id not null", passed: false, detail: "2 NULLs in loan_id" }),
      dqResult({ id: "d3", name: "branch is VARCHAR", passed: true, detail: "type matches" }),
    ]);

    const results = await listRunDqResults(store, "r1");
    expect(results.length).toBe(3);
    // Assert by name, not position — ties on the recorded timestamp make order arbitrary.
    const byName = new Map(results.map((r) => [r.checkName, r]));
    expect(byName.get("row count is positive")?.passed).toBe(true);
    expect(byName.get("loan_id not null")?.passed).toBe(false);
    expect(byName.get("loan_id not null")?.detail).toBe("2 NULLs in loan_id");
    expect(byName.get("branch is VARCHAR")?.passed).toBe(true);
    expect(results.every((r) => r.runId === "r1")).toBe(true);
  });

  it("scopes DQ results to their run", async () => {
    const store = await fresh();
    await createRun(store, { id: "r2", projectId: "p1" });
    await recordDqResults(store, "r1", [dqResult({ id: "d1" })]);
    await recordDqResults(store, "r2", [dqResult({ id: "d2" }), dqResult({ id: "d3" })]);

    expect((await listRunDqResults(store, "r1")).map((r) => r.id)).toEqual(["d1"]);
    expect((await listRunDqResults(store, "r2")).length).toBe(2);
  });

  it("lists a run's approval decisions with the args the human saw", async () => {
    const store = await fresh();
    await recordApproval(store, {
      id: "a1",
      runId: "r1",
      requestId: "req-1",
      tool: "run_transform",
      args: JSON.stringify({ targetTable: "branch_totals" }),
      action: "approve",
    });
    await recordApproval(store, {
      id: "a2",
      runId: "r1",
      requestId: "req-2",
      tool: "publish_serving",
      args: JSON.stringify({ name: "branch_totals" }),
      action: "reject",
    });

    const approvals = await listRunApprovals(store, "r1");
    expect(approvals.map((a) => a.tool)).toEqual(["run_transform", "publish_serving"]);
    expect(approvals[0]?.args).toEqual({ targetTable: "branch_totals" });
    expect(approvals[0]?.action).toBe("approve");
    expect(approvals[1]?.action).toBe("reject");
    // Recorded only once a human answered, so every row carries a decision time.
    expect(approvals.every((a) => a.decidedAt !== null)).toBe(true);
  });

  it("reports unreadable recorded args as not recorded rather than as empty args", async () => {
    const store = await fresh();
    // A corrupted row: `args` holds text that is not a JSON object.
    await store.run(
      `INSERT INTO platform.approvals (id, run_id, request_id, tool, args, action, decided_at)
       VALUES ('a1', 'r1', 'req-1', 'land_parquet', 'not json at all', 'approve', now())`,
    );

    const [approval] = await listRunApprovals(store, "r1");
    // Null, not {} — the view must be able to say the args were not recorded.
    expect(approval?.args).toBeNull();
    expect(approval?.tool).toBe("land_parquet");
  });

  it("assembles the full lineage for a run", async () => {
    const store = await fresh();
    await startToolCall(store, { id: "tc1", runId: "r1", stepId: "s1", tool: "land_parquet", args: {} });
    await completeToolCall(store, "tc1", "success", { result: "landed 3 rows" });
    await recordDqResults(store, "r1", [dqResult({ id: "d1" })]);
    await recordApproval(store, {
      id: "a1",
      runId: "r1",
      requestId: "req-1",
      tool: "land_parquet",
      args: "{}",
      action: "approve",
    });

    const lineage = await getRunLineage(store, "r1");
    expect(lineage?.run.id).toBe("r1");
    expect(lineage?.steps.map((s) => s.name)).toEqual(["land", "dq"]);
    expect(lineage?.toolCalls.map((c) => c.tool)).toEqual(["land_parquet"]);
    expect(lineage?.approvals.map((a) => a.action)).toEqual(["approve"]);
    expect(lineage?.dqResults.map((r) => r.checkName)).toEqual(["row count is positive"]);
  });

  it("assembles lineage for a run that recorded nothing beyond its steps", async () => {
    const store = await fresh();
    const lineage = await getRunLineage(store, "r1");

    // A run that never reached a tool has empty records, not a failed read.
    expect(lineage?.toolCalls).toEqual([]);
    expect(lineage?.approvals).toEqual([]);
    expect(lineage?.dqResults).toEqual([]);
    expect(lineage?.steps.length).toBe(2);
  });

  it("returns null for an unknown run", async () => {
    const store = await fresh();
    expect(await getRunLineage(store, "missing")).toBeNull();
  });
});
