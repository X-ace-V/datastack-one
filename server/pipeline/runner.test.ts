import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openStore, type WarehouseStore } from "../store/duckdb.js";
import { createRun, getRunState, insertRunStep } from "../store/runs.js";
import { getRunLineage } from "../store/lineage.js";
import { getServedTable } from "../store/serving.js";
import { PIPELINE_STAGES, type RunApprovalRequest, type RunEvent, type RunStep } from "../core/run.js";
import type { Source } from "../core/sources.js";
import type { Transform } from "../core/transform.js";
import type { DqSpec } from "../core/dq.js";
import { runPipeline } from "./runner.js";

/**
 * Integration test for the scripted pipeline runner (T4.4/T5.1/T5.2 / PRD FR7/FR8/FR9/FR10) against
 * real DuckDB and a real landing + serving dir on disk. It runs Extract → Land → Load → Transform →
 * DQ → Publish end to end with an auto-approver and asserts the desired result: the marts table is
 * materialized with the exact aggregation, it is served and downloadable as CSV, the run + every
 * step reach `success`, each gated stage requested approval showing the right tool/SQL, and the
 * progress events were emitted in order. It also proves the three abort paths — a human rejection,
 * a stage failure, and a failed DQ check — leave the run in the right terminal state with
 * downstream steps untouched and nothing published.
 */
describe("pipeline runner (Extract → Land → Load → Transform → DQ → Publish)", () => {
  const open: WarehouseStore[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(open.splice(0).map((s) => s.close()));
    await Promise.all(
      tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
    );
  });

  const LOANS_CSV =
    "loan_id,branch,balance\n" +
    "1,north,1000.50\n" +
    "2,south,\n" +
    "3,north,750.25\n";

  const TRANSFORM: Transform = {
    sql:
      "CREATE OR REPLACE TABLE marts.branch_balance_totals AS " +
      "SELECT branch, SUM(COALESCE(balance, 0)) AS total_balance FROM raw.source GROUP BY branch",
    targetTable: "branch_balance_totals",
    assumptions: ["null balances count as zero"],
    questions: [],
  };

  // Checks that all pass against the loaded fixture: raw.source has 3 rows, no null loan_id, a
  // `branch` column, and a non-null `ingestion_date` (added by the land stage).
  const PASSING_DQ: DqSpec = {
    targetTable: "raw.source",
    checks: [
      { name: "rows present", type: "row_count", column: null, description: "at least one row" },
      { name: "id not null", type: "not_null", column: "loan_id", description: "loan_id not null" },
      { name: "branch present", type: "schema", column: "branch", description: "branch exists" },
      { name: "fresh", type: "freshness", column: "ingestion_date", description: "date present" },
    ],
  };

  /** Stand up a store with a project, a run, its pending steps, a source CSV, and a landing dir. */
  async function scaffold(): Promise<{
    store: WarehouseStore;
    runId: string;
    steps: RunStep[];
    source: Source;
    landingDir: string;
    servingDir: string;
  }> {
    const store = await openStore(":memory:");
    open.push(store);
    const dir = await mkdtemp(join(tmpdir(), "datastack-runner-"));
    tempDirs.push(dir);
    const csv = join(dir, "loans.csv");
    await writeFile(csv, LOANS_CSV);

    await store.run(
      `INSERT INTO platform.projects (id, name, domain) VALUES ('p1', 'Loans', 'lending')`,
    );
    const run = await createRun(store, { id: "run1", projectId: "p1" });
    const steps: RunStep[] = [];
    for (const [ordinal, stage] of PIPELINE_STAGES.entries()) {
      steps.push(
        await insertRunStep(store, {
          id: `step-${stage.name}`,
          runId: run.id,
          name: stage.name,
          ordinal,
        }),
      );
    }
    const source: Source = {
      id: "src1",
      projectId: "p1",
      kind: "csv",
      path: csv,
      originalFilename: "loans.csv",
      rowCount: 3,
      createdAt: "2026-07-17 00:00:00",
    };
    return {
      store,
      runId: run.id,
      steps,
      source,
      landingDir: join(dir, "landing"),
      servingDir: join(dir, "serving"),
    };
  }

  it("runs every stage to success, materializes marts, and serves it as CSV", async () => {
    const { store, runId, steps, source, landingDir, servingDir } = await scaffold();
    const requests: RunApprovalRequest[] = [];
    const events: RunEvent[] = [];

    const state = await runPipeline({
      store,
      runId,
      steps,
      source,
      transform: TRANSFORM,
      dqSpec: PASSING_DQ,
      landingDir,
      servingDir,
      ingestionDate: "2026-07-17",
      approve: async (request) => {
        requests.push(request);
        return "approve";
      },
      emit: (event) => events.push(event),
    });

    // The run and every step ended in success.
    expect(state.run.status).toBe("success");
    expect(state.steps.map((s) => s.name)).toEqual([
      "extract",
      "land",
      "load",
      "transform",
      "dq",
      "publish",
    ]);
    expect(state.steps.every((s) => s.status === "success")).toBe(true);
    // Step details reflect what actually happened at each stage.
    expect(state.steps[0]!.detail).toMatch(/read 3 rows/);
    expect(state.steps[1]!.detail).toMatch(/landed 3 rows/);
    expect(state.steps[2]!.detail).toMatch(/loaded 3 rows → raw\.source/);
    expect(state.steps[3]!.detail).toMatch(/materialized 2 rows → marts\.branch_balance_totals/);
    expect(state.steps[4]!.detail).toMatch(/4 DQ checks passed against raw\.source/);
    expect(state.steps[5]!.detail).toMatch(
      /published 2 rows → \/api\/serve\/branch_balance_totals/,
    );
    // Started/finished timestamps were stamped.
    expect(state.steps.every((s) => s.startedAt && s.finishedAt)).toBe(true);

    // The four gated tools each requested approval, in order, with the exact SQL where there is
    // one to show (the transform's statement and the publish's COPY).
    expect(requests.map((r) => r.tool)).toEqual([
      "land_parquet",
      "load_warehouse",
      "run_transform",
      "publish_serving",
    ]);
    expect(requests[2]!.sql).toBe(TRANSFORM.sql);
    expect(requests[0]!.sql).toBeNull();
    expect(requests[3]!.sql).toContain(`COPY (SELECT * FROM "marts"."branch_balance_totals")`);
    expect(requests[3]!.sql).toContain("(FORMAT CSV, HEADER)");

    // The marts table holds the coalesced per-branch totals.
    const rows = await store.all(
      `SELECT branch, total_balance FROM marts.branch_balance_totals ORDER BY branch`,
    );
    expect(rows).toEqual([
      { branch: "north", total_balance: 1750.75 },
      { branch: "south", total_balance: 0 },
    ]);

    // FR10: the report is registered as a served endpoint and downloadable as CSV on disk.
    const served = await getServedTable(store, "branch_balance_totals");
    expect(served).toMatchObject({
      projectId: "p1",
      runId,
      qualifiedTable: "marts.branch_balance_totals",
      format: "csv",
      rowCount: 2,
      endpoint: "/api/serve/branch_balance_totals",
      csvEndpoint: "/api/serve/branch_balance_totals.csv",
    });
    // Header first, then every marts row. Row order is deliberately not asserted: the transform's
    // GROUP BY carries no ORDER BY and the export is a plain SELECT *, so the order the engine
    // returns groups in is not part of the served contract — the rows and values are.
    const csvLines = (await readFile(served!.csvPath, "utf8")).trimEnd().split("\n");
    expect(csvLines[0]).toBe("branch,total_balance");
    expect(csvLines.slice(1).sort()).toEqual(["north,1750.75", "south,0.0"]);

    // Progress events bracket the run and cover each step + approval pair.
    expect(events[0]).toEqual({ kind: "run.status", runId, status: "running" });
    expect(events.at(-1)).toEqual({ kind: "run.status", runId, status: "success" });
    expect(events.filter((e) => e.kind === "approval.requested")).toHaveLength(4);
    expect(events.filter((e) => e.kind === "approval.resolved")).toHaveLength(4);
    expect(
      events.filter((e) => e.kind === "step.status" && e.status === "success"),
    ).toHaveLength(6);
  });

  it("aborts the run as 'rejected' when a human rejects the first gated stage", async () => {
    const { store, runId, steps, source, landingDir, servingDir } = await scaffold();

    const state = await runPipeline({
      store,
      runId,
      steps,
      source,
      transform: TRANSFORM,
      dqSpec: PASSING_DQ,
      landingDir,
      servingDir,
      ingestionDate: "2026-07-17",
      // Reject the land stage; approve anything else (never reached).
      approve: async (request) => (request.tool === "land_parquet" ? "reject" : "approve"),
    });

    expect(state.run.status).toBe("rejected");
    const byName = new Map(state.steps.map((s) => [s.name, s]));
    expect(byName.get("extract")!.status).toBe("success");
    expect(byName.get("land")!.status).toBe("failed");
    expect(byName.get("land")!.detail).toMatch(/rejected by human/);
    // Downstream stages never ran.
    expect(byName.get("load")!.status).toBe("pending");
    expect(byName.get("transform")!.status).toBe("pending");
    expect(byName.get("publish")!.status).toBe("pending");

    // Nothing was landed/loaded/transformed.
    const marts = await store.all(
      `SELECT count(*)::BIGINT AS n FROM information_schema.tables ` +
        `WHERE table_schema = 'marts'`,
    );
    expect(Number(marts[0]?.n)).toBe(0);
    // And nothing was published — a rejected write never reaches an endpoint.
    expect(await getServedTable(store, "branch_balance_totals")).toBeNull();
  });

  it("aborts the run as 'failed' when a stage errors", async () => {
    const { store, runId, steps, source, landingDir, servingDir } = await scaffold();

    const state = await runPipeline({
      store,
      runId,
      steps,
      source,
      transform: {
        sql: "CREATE OR REPLACE TABLE marts.broken AS SELECT * FROM raw.does_not_exist",
        targetTable: "broken",
        assumptions: [],
        questions: [],
      },
      dqSpec: PASSING_DQ,
      landingDir,
      servingDir,
      ingestionDate: "2026-07-17",
      approve: async () => "approve",
    });

    expect(state.run.status).toBe("failed");
    const byName = new Map(state.steps.map((s) => [s.name, s]));
    // Extract/Land/Load succeeded; the transform SQL failed at execution.
    expect(byName.get("load")!.status).toBe("success");
    expect(byName.get("transform")!.status).toBe("failed");
    expect(byName.get("transform")!.detail).toBeTruthy();
  });

  it("fails the run when a DQ check fails, blocking publish", async () => {
    const { store, runId, steps, source, landingDir, servingDir } = await scaffold();

    // A spec whose not_null check targets `balance` — which has a null in the fixture — so the DQ
    // stage fails even though extract/land/load/transform all succeeded.
    const FAILING_DQ: DqSpec = {
      targetTable: "raw.source",
      checks: [
        { name: "rows present", type: "row_count", column: null, description: "at least one row" },
        {
          name: "balance not null",
          type: "not_null",
          column: "balance",
          description: "balance never null",
        },
        { name: "branch present", type: "schema", column: "branch", description: "branch exists" },
        { name: "fresh", type: "freshness", column: "ingestion_date", description: "date present" },
      ],
    };

    const state = await runPipeline({
      store,
      runId,
      steps,
      source,
      transform: TRANSFORM,
      dqSpec: FAILING_DQ,
      landingDir,
      servingDir,
      // A publish approval would be a bug here — the DQ failure must stop the run before the
      // gate is ever offered, so approving everything cannot rescue it.
      ingestionDate: "2026-07-17",
      approve: async () => "approve",
    });

    // The run failed at the DQ stage — nothing publishes past a failed check (FR7).
    expect(state.run.status).toBe("failed");
    const byName = new Map(state.steps.map((s) => [s.name, s]));
    // The write stages still succeeded; only the DQ gate blocked the run.
    expect(byName.get("transform")!.status).toBe("success");
    expect(byName.get("dq")!.status).toBe("failed");
    expect(byName.get("dq")!.detail).toMatch(/balance not null/);

    // The transform still materialized marts, proving the run reached DQ before being blocked —
    // the DQ failure is what stops publish, not an earlier stage error.
    const marts = await store.all(
      `SELECT count(*)::BIGINT AS n FROM marts.branch_balance_totals`,
    );
    expect(Number(marts[0]?.n)).toBe(2);

    // FR7's actual requirement: publish never ran. The stage stayed pending, no endpoint was
    // registered, and no CSV was exported — even though every approval was granted.
    expect(byName.get("publish")!.status).toBe("pending");
    expect(await getServedTable(store, "branch_balance_totals")).toBeNull();
    await expect(
      readFile(join(servingDir, "p1", "branch_balance_totals.csv"), "utf8"),
    ).rejects.toThrow();
  });

  it("records the lineage of a successful run: every tool call and every DQ result", async () => {
    const { store, runId, steps, source, landingDir, servingDir } = await scaffold();
    await runPipeline({
      store,
      runId,
      steps,
      source,
      transform: TRANSFORM,
      dqSpec: PASSING_DQ,
      landingDir,
      servingDir,
      ingestionDate: "2026-07-17",
      approve: async () => "approve",
    });

    const lineage = await getRunLineage(store, runId);

    // FR12: one record per tool the runner executed, in execution order. Extract runs no tool, so
    // the five here are a strict record of tool execution rather than a copy of the six steps.
    expect(lineage!.toolCalls.map((c) => c.tool)).toEqual([
      "land_parquet",
      "load_warehouse",
      "run_transform",
      "run_dq_check",
      "publish_serving",
    ]);
    expect(lineage!.toolCalls.every((c) => c.status === "success")).toBe(true);
    expect(lineage!.toolCalls.every((c) => c.finishedAt !== null && c.error === null)).toBe(true);

    // Each call records what actually came back, not a generic "ok".
    const byTool = new Map(lineage!.toolCalls.map((c) => [c.tool, c]));
    expect(byTool.get("land_parquet")!.result).toMatch(/landed 3 rows/);
    expect(byTool.get("load_warehouse")!.result).toMatch(/loaded 3 rows → raw\.source/);
    expect(byTool.get("run_transform")!.result).toMatch(
      /materialized 2 rows → marts\.branch_balance_totals/,
    );
    expect(byTool.get("publish_serving")!.result).toMatch(/published 2 rows/);

    // Every tool call is attributed to the stage it ran under, so lineage ties to the visible steps.
    const stepIds = new Set(steps.map((s) => s.id));
    expect(lineage!.toolCalls.every((c) => stepIds.has(c.stepId))).toBe(true);
    expect(byTool.get("run_transform")!.stepId).toBe("step-transform");

    // The recorded args are the ones the tool actually ran with — the transform records the exact
    // reviewed SQL that executed.
    expect(byTool.get("run_transform")!.args).toEqual({
      targetTable: "branch_balance_totals",
      sql: TRANSFORM.sql,
    });
    expect(byTool.get("land_parquet")!.args).toMatchObject({
      dataset: "loans.csv",
      ingestionDate: "2026-07-17",
    });

    // FR12: every executed DQ check is recorded, not just the aggregate the step detail carries.
    expect(lineage!.dqResults.length).toBe(4);
    expect(lineage!.dqResults.every((r) => r.passed)).toBe(true);
    expect(new Set(lineage!.dqResults.map((r) => r.checkName))).toEqual(
      new Set(["rows present", "id not null", "branch present", "fresh"]),
    );
    expect(lineage!.dqResults.every((r) => r.detail !== null)).toBe(true);

    // The lineage carries the run and its six steps alongside those records.
    expect(lineage!.run.status).toBe("success");
    expect(lineage!.steps.length).toBe(6);
  });

  it("records the DQ results that blocked publish when a check fails", async () => {
    const { store, runId, steps, source, landingDir, servingDir } = await scaffold();
    const FAILING_DQ: DqSpec = {
      targetTable: "raw.source",
      checks: [
        { name: "rows present", type: "row_count", column: null, description: "at least one row" },
        { name: "id not null", type: "not_null", column: "loan_id", description: "loan_id not null" },
        // The fixture's row 2 has a null balance, so this check fails.
        { name: "balance not null", type: "not_null", column: "balance", description: "balance set" },
        { name: "branch present", type: "schema", column: "branch", description: "branch exists" },
      ],
    };

    await runPipeline({
      store,
      runId,
      steps,
      source,
      transform: TRANSFORM,
      dqSpec: FAILING_DQ,
      landingDir,
      servingDir,
      ingestionDate: "2026-07-17",
      approve: async () => "approve",
    });

    const lineage = await getRunLineage(store, runId);

    // The record of WHY publish was blocked is what makes the FR7 block auditable: all four checks
    // are recorded even though the run aborted, and exactly the failing one reads false.
    expect(lineage!.dqResults.length).toBe(4);
    const failed = lineage!.dqResults.filter((r) => !r.passed);
    expect(failed.map((r) => r.checkName)).toEqual(["balance not null"]);
    expect(failed[0]!.detail).toMatch(/balance/i);

    // run_dq_check itself SUCCEEDED — it reports pass/fail rather than throwing — so the record
    // shows a successful call whose outcome then failed the stage.
    const dqCall = lineage!.toolCalls.find((c) => c.tool === "run_dq_check");
    expect(dqCall!.status).toBe("success");
    expect(dqCall!.result).toMatch(/1 of 4 DQ checks failed against raw\.source/);

    // publish_serving never ran, so it left no tool call at all (FR7).
    expect(lineage!.toolCalls.map((c) => c.tool)).not.toContain("publish_serving");
    expect(lineage!.run.status).toBe("failed");
  });

  it("records a rejected run's lineage: no tool call for the gate a human denied", async () => {
    const { store, runId, steps, source, landingDir, servingDir } = await scaffold();
    await runPipeline({
      store,
      runId,
      steps,
      source,
      transform: TRANSFORM,
      dqSpec: PASSING_DQ,
      landingDir,
      servingDir,
      ingestionDate: "2026-07-17",
      approve: async (request) => (request.tool === "land_parquet" ? "reject" : "approve"),
    });

    const lineage = await getRunLineage(store, runId);

    // Nothing executed: the rejected tool left no call record, which is the lineage evidence that
    // a denied gate really does stop execution (FR8) rather than merely marking a step failed.
    expect(lineage!.toolCalls).toEqual([]);
    expect(lineage!.dqResults).toEqual([]);
    expect(lineage!.run.status).toBe("rejected");
  });

  it("records a failed tool call with its error", async () => {
    const { store, runId, steps, source, landingDir, servingDir } = await scaffold();
    await runPipeline({
      store,
      runId,
      steps,
      source,
      // A transform whose SQL is valid but writes a different table than it claims: run_transform's
      // marts read-back throws, so the tool call fails for a real reason.
      transform: { ...TRANSFORM, targetTable: "never_created" },
      dqSpec: PASSING_DQ,
      landingDir,
      servingDir,
      ingestionDate: "2026-07-17",
      approve: async () => "approve",
    });

    const lineage = await getRunLineage(store, runId);
    const failedCall = lineage!.toolCalls.find((c) => c.tool === "run_transform");

    expect(failedCall!.status).toBe("failed");
    expect(failedCall!.error).toBeTruthy();
    expect(failedCall!.result).toBeNull();
    expect(failedCall!.finishedAt).not.toBeNull();
    // The two tools that ran before it stayed successful — a failure is recorded, not retroactive.
    expect(lineage!.toolCalls.filter((c) => c.status === "success").map((c) => c.tool)).toEqual([
      "land_parquet",
      "load_warehouse",
    ]);
    expect(lineage!.run.status).toBe("failed");
  });

  it("persists the terminal state independently of the returned value", async () => {
    const { store, runId, steps, source, landingDir, servingDir } = await scaffold();
    await runPipeline({
      store,
      runId,
      steps,
      source,
      transform: TRANSFORM,
      dqSpec: PASSING_DQ,
      landingDir,
      servingDir,
      ingestionDate: "2026-07-17",
      approve: async () => "approve",
    });

    // Re-reading from the store yields the same success state (proves persistence, not just return).
    const reread = await getRunState(store, runId);
    expect(reread?.run.status).toBe("success");
    expect(reread?.steps.every((s) => s.status === "success")).toBe(true);
  });
});
