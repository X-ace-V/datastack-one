import { afterEach, describe, expect, it } from "vitest";
import { openStore, type WarehouseStore } from "./duckdb.js";
import {
  completeRunStep,
  createRun,
  getRun,
  getRunState,
  insertRunStep,
  listRunSteps,
  listRuns,
  recordApproval,
  startRunStep,
  updateRunStatus,
} from "./runs.js";

/** Persistence tests for runs, run steps, and the approval audit trail (T4.4) on a real store. */
describe("run store", () => {
  const open: WarehouseStore[] = [];

  afterEach(async () => {
    await Promise.all(open.splice(0).map((s) => s.close()));
  });

  async function fresh(): Promise<WarehouseStore> {
    const store = await openStore(":memory:");
    open.push(store);
    await store.run(
      `INSERT INTO platform.projects (id, name, domain) VALUES ('p1', 'Loans', 'lending')`,
    );
    return store;
  }

  it("creates a run with defaults and reads it back", async () => {
    const store = await fresh();
    const run = await createRun(store, { id: "r1", projectId: "p1" });

    expect(run.id).toBe("r1");
    expect(run.projectId).toBe("p1");
    expect(run.status).toBe("pending");
    expect(run.model).toBeNull();
    expect(typeof run.createdAt).toBe("string");
    expect(await getRun(store, "r1")).toEqual(run);
    expect(await getRun(store, "missing")).toBeNull();
  });

  it("records a per-run model when given", async () => {
    const store = await fresh();
    const run = await createRun(store, { id: "r1", projectId: "p1", model: "anthropic/opus" });
    expect(run.model).toBe("anthropic/opus");
  });

  it("lists a project's runs newest first and scopes them to that project", async () => {
    const store = await fresh();
    await store.run(
      `INSERT INTO platform.projects (id, name, domain) VALUES ('p2', 'Other', 'lending')`,
    );
    // Stamp explicit creation times so "newest first" is asserted against known values rather
    // than the resolution of two back-to-back now() calls.
    await createRun(store, { id: "r1", projectId: "p1" });
    await createRun(store, { id: "r2", projectId: "p1" });
    await createRun(store, { id: "r3", projectId: "p2" });
    await store.run(`UPDATE platform.runs SET created_at = TIMESTAMP '2026-07-16 09:00:00' WHERE id = 'r1'`);
    await store.run(`UPDATE platform.runs SET created_at = TIMESTAMP '2026-07-17 09:00:00' WHERE id = 'r2'`);

    const runs = await listRuns(store, "p1");
    expect(runs.map((r) => r.id)).toEqual(["r2", "r1"]);
    // Another project's runs never appear in this project's history.
    expect((await listRuns(store, "p2")).map((r) => r.id)).toEqual(["r3"]);
    // A project that has never run is an empty history, not an error.
    expect(await listRuns(store, "missing")).toEqual([]);
  });

  it("inserts pending steps and lists them in pipeline order", async () => {
    const store = await fresh();
    await createRun(store, { id: "r1", projectId: "p1" });
    // Insert out of order; listing must sort by ordinal.
    await insertRunStep(store, { id: "s2", runId: "r1", name: "land", ordinal: 1 });
    await insertRunStep(store, { id: "s1", runId: "r1", name: "extract", ordinal: 0 });

    const steps = await listRunSteps(store, "r1");
    expect(steps.map((s) => s.name)).toEqual(["extract", "land"]);
    expect(steps.every((s) => s.status === "pending")).toBe(true);
    expect(steps.every((s) => s.startedAt === null && s.finishedAt === null)).toBe(true);
  });

  it("transitions a step running → success with detail + timestamps", async () => {
    const store = await fresh();
    await createRun(store, { id: "r1", projectId: "p1" });
    await insertRunStep(store, { id: "s1", runId: "r1", name: "extract", ordinal: 0 });

    await startRunStep(store, "s1");
    let steps = await listRunSteps(store, "r1");
    expect(steps[0]!.status).toBe("running");
    expect(steps[0]!.startedAt).not.toBeNull();

    await completeRunStep(store, "s1", "success", "read 3 rows");
    steps = await listRunSteps(store, "r1");
    expect(steps[0]!.status).toBe("success");
    expect(steps[0]!.detail).toBe("read 3 rows");
    expect(steps[0]!.finishedAt).not.toBeNull();
  });

  it("updates the run status and bumps updated_at", async () => {
    const store = await fresh();
    await createRun(store, { id: "r1", projectId: "p1" });
    await updateRunStatus(store, "r1", "running");
    await updateRunStatus(store, "r1", "success");
    expect((await getRun(store, "r1"))!.status).toBe("success");
  });

  it("assembles run state (run + ordered steps), or null for an unknown run", async () => {
    const store = await fresh();
    await createRun(store, { id: "r1", projectId: "p1" });
    await insertRunStep(store, { id: "s1", runId: "r1", name: "extract", ordinal: 0 });
    await insertRunStep(store, { id: "s2", runId: "r1", name: "land", ordinal: 1 });

    const state = await getRunState(store, "r1");
    expect(state?.run.id).toBe("r1");
    expect(state?.steps.map((s) => s.name)).toEqual(["extract", "land"]);
    expect(await getRunState(store, "missing")).toBeNull();
  });

  it("records a resolved approval to the audit trail", async () => {
    const store = await fresh();
    await createRun(store, { id: "r1", projectId: "p1" });
    await recordApproval(store, {
      id: "a1",
      runId: "r1",
      requestId: "req1",
      tool: "run_transform",
      args: JSON.stringify({ targetTable: "x" }),
      action: "approve",
    });

    const rows = await store.all(
      `SELECT run_id, request_id, tool, args, action, decided_at FROM platform.approvals WHERE id = 'a1'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tool).toBe("run_transform");
    expect(rows[0]!.action).toBe("approve");
    expect(rows[0]!.request_id).toBe("req1");
    expect(rows[0]!.decided_at).not.toBeNull();
  });
});
