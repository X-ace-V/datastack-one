import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "./app.js";
import { openStore, type WarehouseStore } from "./store/duckdb.js";
import { insertProject } from "./store/projects.js";
import { CreateProjectRequestSchema } from "./core/projects.js";
import { createRun, insertRunStep, recordApproval } from "./store/runs.js";
import { completeToolCall, recordDqResults, startToolCall } from "./store/lineage.js";
import type { RunLineage } from "./core/lineage.js";
import type { Run } from "./core/run.js";

/**
 * Route tests for the run-lineage surface (T5.5, FR12) over a real in-memory warehouse:
 * `GET /api/runs/:runId/lineage` (one run's full audit record) and `GET /api/projects/:id/runs`
 * (the history it is opened from). The records are seeded through the real store functions, so
 * these assert the wire contract the run detail view actually consumes.
 */
describe("lineage routes", () => {
  const open: WarehouseStore[] = [];

  afterEach(async () => {
    await Promise.all(open.splice(0).map((s) => s.close()));
  });

  /** A store with a project and one fully-recorded run: steps, tool calls, approvals, DQ results. */
  async function seeded(): Promise<{ store: WarehouseStore; projectId: string; runId: string }> {
    const store = await openStore(":memory:");
    open.push(store);
    const project = await insertProject(
      store,
      CreateProjectRequestSchema.parse({ name: "Loans", domain: "lending" }),
    );
    const run = await createRun(store, { id: "run1", projectId: project.id });
    await insertRunStep(store, { id: "st1", runId: run.id, name: "extract", ordinal: 0 });
    await insertRunStep(store, { id: "st2", runId: run.id, name: "transform", ordinal: 1 });

    await startToolCall(store, {
      id: "tc1",
      runId: run.id,
      stepId: "st2",
      tool: "run_transform",
      args: { targetTable: "branch_totals" },
    });
    await completeToolCall(store, "tc1", "success", {
      result: "materialized 2 rows → marts.branch_totals",
    });
    await recordApproval(store, {
      id: "ap1",
      runId: run.id,
      requestId: "req-1",
      tool: "run_transform",
      args: JSON.stringify({ targetTable: "branch_totals" }),
      action: "approve",
    });
    await recordDqResults(store, run.id, [
      {
        id: "dq1",
        name: "rows present",
        type: "row_count",
        column: null,
        passed: true,
        detail: "3 rows",
      },
      {
        id: "dq2",
        name: "balance not null",
        type: "not_null",
        column: "balance",
        passed: false,
        detail: "1 NULL in balance",
      },
    ]);
    return { store, projectId: project.id, runId: run.id };
  }

  it("returns a run's full lineage", async () => {
    const { store, runId } = await seeded();
    const app = buildServer({ store });

    const res = await app.inject({ method: "GET", url: `/api/runs/${runId}/lineage` });
    expect(res.statusCode).toBe(200);
    const body = res.json<RunLineage>();

    expect(body.run.id).toBe(runId);
    expect(body.steps.map((s) => s.name)).toEqual(["extract", "transform"]);

    // The tool call carries what ran, with which args, and what came back.
    expect(body.toolCalls.length).toBe(1);
    expect(body.toolCalls[0]).toMatchObject({
      tool: "run_transform",
      stepId: "st2",
      status: "success",
      result: "materialized 2 rows → marts.branch_totals",
      error: null,
      args: { targetTable: "branch_totals" },
    });

    // The approval trail proves the write tool was approved by a human (FR8).
    expect(body.approvals.length).toBe(1);
    expect(body.approvals[0]).toMatchObject({
      tool: "run_transform",
      action: "approve",
      args: { targetTable: "branch_totals" },
    });
    expect(body.approvals[0]?.decidedAt).toBeTruthy();

    // Both DQ outcomes are present — the failing one is why a publish would be blocked (FR7).
    expect(body.dqResults.length).toBe(2);
    const byName = new Map(body.dqResults.map((r) => [r.checkName, r]));
    expect(byName.get("rows present")?.passed).toBe(true);
    expect(byName.get("balance not null")?.passed).toBe(false);
    expect(byName.get("balance not null")?.detail).toBe("1 NULL in balance");
  });

  it("returns empty record lists for a run that recorded nothing beyond its steps", async () => {
    const { store, projectId } = await seeded();
    await createRun(store, { id: "run2", projectId });
    await insertRunStep(store, { id: "st9", runId: "run2", name: "extract", ordinal: 0 });
    const app = buildServer({ store });

    const res = await app.inject({ method: "GET", url: "/api/runs/run2/lineage" });
    expect(res.statusCode).toBe(200);
    const body = res.json<RunLineage>();

    // A run that never reached a tool reports empty records, not a 404 or a failed read.
    expect(body.toolCalls).toEqual([]);
    expect(body.approvals).toEqual([]);
    expect(body.dqResults).toEqual([]);
    expect(body.steps.length).toBe(1);
  });

  it("never leaks another run's records into a run's lineage", async () => {
    const { store, projectId, runId } = await seeded();
    await createRun(store, { id: "run2", projectId });
    await startToolCall(store, {
      id: "tc9",
      runId: "run2",
      stepId: "st1",
      tool: "land_parquet",
      args: {},
    });
    const app = buildServer({ store });

    const first = (await app.inject({ method: "GET", url: `/api/runs/${runId}/lineage` })).json<RunLineage>();
    const second = (await app.inject({ method: "GET", url: "/api/runs/run2/lineage" })).json<RunLineage>();

    expect(first.toolCalls.map((c) => c.tool)).toEqual(["run_transform"]);
    expect(second.toolCalls.map((c) => c.tool)).toEqual(["land_parquet"]);
    expect(second.dqResults).toEqual([]);
  });

  it("404s an unknown run", async () => {
    const { store } = await seeded();
    const app = buildServer({ store });
    const res = await app.inject({ method: "GET", url: "/api/runs/nope/lineage" });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: string }>().error).toMatch(/run not found/i);
  });

  it("503s when the store is unwired", async () => {
    const app = buildServer({});
    const res = await app.inject({ method: "GET", url: "/api/runs/run1/lineage" });
    expect(res.statusCode).toBe(503);
  });

  it("lists a project's runs newest first", async () => {
    const { store, projectId, runId } = await seeded();
    await createRun(store, { id: "run2", projectId });
    await store.run(
      `UPDATE platform.runs SET created_at = TIMESTAMP '2026-07-16 09:00:00' WHERE id = $1`,
      [runId],
    );
    await store.run(
      `UPDATE platform.runs SET created_at = TIMESTAMP '2026-07-17 09:00:00' WHERE id = 'run2'`,
    );
    const app = buildServer({ store });

    const res = await app.inject({ method: "GET", url: `/api/projects/${projectId}/runs` });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ runs: Run[] }>().runs.map((r) => r.id)).toEqual(["run2", runId]);
  });

  it("returns an empty history for a project that has never run", async () => {
    const { store } = await seeded();
    const other = await insertProject(
      store,
      CreateProjectRequestSchema.parse({ name: "Fresh", domain: "lending" }),
    );
    const app = buildServer({ store });

    const res = await app.inject({ method: "GET", url: `/api/projects/${other.id}/runs` });
    // A project that has not run yet is a normal pre-run state, not a 404.
    expect(res.statusCode).toBe(200);
    expect(res.json<{ runs: Run[] }>().runs).toEqual([]);
  });

  it("scopes the run history to its project", async () => {
    const { store, projectId } = await seeded();
    const other = await insertProject(
      store,
      CreateProjectRequestSchema.parse({ name: "Other", domain: "lending" }),
    );
    await createRun(store, { id: "run-other", projectId: other.id });
    const app = buildServer({ store });

    const mine = (
      await app.inject({ method: "GET", url: `/api/projects/${projectId}/runs` })
    ).json<{ runs: Run[] }>();
    expect(mine.runs.map((r) => r.id)).toEqual(["run1"]);
  });

  it("404s the run history of an unknown project", async () => {
    const { store } = await seeded();
    const app = buildServer({ store });
    const res = await app.inject({ method: "GET", url: "/api/projects/nope/runs" });
    expect(res.statusCode).toBe(404);
  });

  it("503s the run history when the store is unwired", async () => {
    const app = buildServer({});
    const res = await app.inject({ method: "GET", url: "/api/projects/p1/runs" });
    expect(res.statusCode).toBe(503);
  });
});
