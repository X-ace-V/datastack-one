import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openStore, type WarehouseStore } from "../store/duckdb.js";
import { createRun, getRunState, insertRunStep } from "../store/runs.js";
import { PIPELINE_STAGES, type RunApprovalRequest, type RunEvent, type RunStep } from "../core/run.js";
import type { Source } from "../core/sources.js";
import type { Transform } from "../core/transform.js";
import { runPipeline } from "./runner.js";

/**
 * Integration test for the scripted pipeline runner (T4.4 / PRD FR8/FR9) against real DuckDB and a
 * real landing dir on disk. It runs Extract → Land → Load → Transform end to end with an
 * auto-approver and asserts the desired result: the marts table is materialized with the exact
 * aggregation, the run + every step reach `success`, each gated stage requested approval showing
 * the right tool/SQL, and the progress events were emitted in order. It also proves the two
 * abort paths — a human rejection and a stage failure — leave the run in the right terminal state
 * with downstream steps untouched.
 */
describe("pipeline runner (Extract → Land → Load → Transform)", () => {
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

  /** Stand up a store with a project, a run, its pending steps, a source CSV, and a landing dir. */
  async function scaffold(): Promise<{
    store: WarehouseStore;
    runId: string;
    steps: RunStep[];
    source: Source;
    landingDir: string;
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
    return { store, runId: run.id, steps, source, landingDir: join(dir, "landing") };
  }

  it("runs every stage to success and materializes marts with the exact aggregation", async () => {
    const { store, runId, steps, source, landingDir } = await scaffold();
    const requests: RunApprovalRequest[] = [];
    const events: RunEvent[] = [];

    const state = await runPipeline({
      store,
      runId,
      steps,
      source,
      transform: TRANSFORM,
      landingDir,
      ingestionDate: "2026-07-17",
      approve: async (request) => {
        requests.push(request);
        return "approve";
      },
      emit: (event) => events.push(event),
    });

    // The run and every step ended in success.
    expect(state.run.status).toBe("success");
    expect(state.steps.map((s) => s.name)).toEqual(["extract", "land", "load", "transform"]);
    expect(state.steps.every((s) => s.status === "success")).toBe(true);
    // Step details reflect what actually happened at each stage.
    expect(state.steps[0]!.detail).toMatch(/read 3 rows/);
    expect(state.steps[1]!.detail).toMatch(/landed 3 rows/);
    expect(state.steps[2]!.detail).toMatch(/loaded 3 rows → raw\.source/);
    expect(state.steps[3]!.detail).toMatch(/materialized 2 rows → marts\.branch_balance_totals/);
    // Started/finished timestamps were stamped.
    expect(state.steps.every((s) => s.startedAt && s.finishedAt)).toBe(true);

    // The three gated tools each requested approval, in order, with the transform's exact SQL.
    expect(requests.map((r) => r.tool)).toEqual([
      "land_parquet",
      "load_warehouse",
      "run_transform",
    ]);
    expect(requests[2]!.sql).toBe(TRANSFORM.sql);
    expect(requests[0]!.sql).toBeNull();

    // The marts table holds the coalesced per-branch totals.
    const rows = await store.all(
      `SELECT branch, total_balance FROM marts.branch_balance_totals ORDER BY branch`,
    );
    expect(rows).toEqual([
      { branch: "north", total_balance: 1750.75 },
      { branch: "south", total_balance: 0 },
    ]);

    // Progress events bracket the run and cover each step + approval pair.
    expect(events[0]).toEqual({ kind: "run.status", runId, status: "running" });
    expect(events.at(-1)).toEqual({ kind: "run.status", runId, status: "success" });
    expect(events.filter((e) => e.kind === "approval.requested")).toHaveLength(3);
    expect(events.filter((e) => e.kind === "approval.resolved")).toHaveLength(3);
    expect(
      events.filter((e) => e.kind === "step.status" && e.status === "success"),
    ).toHaveLength(4);
  });

  it("aborts the run as 'rejected' when a human rejects the first gated stage", async () => {
    const { store, runId, steps, source, landingDir } = await scaffold();

    const state = await runPipeline({
      store,
      runId,
      steps,
      source,
      transform: TRANSFORM,
      landingDir,
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

    // Nothing was landed/loaded/transformed.
    const marts = await store.all(
      `SELECT count(*)::BIGINT AS n FROM information_schema.tables ` +
        `WHERE table_schema = 'marts'`,
    );
    expect(Number(marts[0]?.n)).toBe(0);
  });

  it("aborts the run as 'failed' when a stage errors", async () => {
    const { store, runId, steps, source, landingDir } = await scaffold();

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
      landingDir,
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

  it("persists the terminal state independently of the returned value", async () => {
    const { store, runId, steps, source, landingDir } = await scaffold();
    await runPipeline({
      store,
      runId,
      steps,
      source,
      transform: TRANSFORM,
      landingDir,
      ingestionDate: "2026-07-17",
      approve: async () => "approve",
    });

    // Re-reading from the store yields the same success state (proves persistence, not just return).
    const reread = await getRunState(store, runId);
    expect(reread?.run.status).toBe("success");
    expect(reread?.steps.every((s) => s.status === "success")).toBe(true);
  });
});
