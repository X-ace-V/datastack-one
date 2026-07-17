import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openStore, type WarehouseStore } from "../store/duckdb.js";
import { DqRunResultSchema, type DqSpec } from "../core/dq.js";
import { landParquet } from "./land.js";
import { loadWarehouse } from "./warehouse.js";
import { runDqCheck } from "./dq.js";

/**
 * Integration test for the `run_dq_check` tool (T5.1 / PRD FR7) against real DuckDB. It lands +
 * loads a fixture into `raw.source` (the T4.1/T4.2 seam), then executes real DQ specs and asserts
 * the desired result: a clean spec passes every check, a spec whose not_null check targets a column
 * with a NULL fails that check and turns the aggregate `passed` false (which blocks publish), and a
 * check on a missing column fails honestly rather than throwing. Pure helpers are covered in
 * {@link file://../core/dq.test.ts}.
 */
describe("run_dq_check tool (execute reviewed checks against raw.source)", () => {
  const open: WarehouseStore[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(open.splice(0).map((s) => s.close()));
    await Promise.all(
      tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
    );
  });

  // Synthetic lending source: loan_id (unique, non-null), branch (non-null), balance (one null),
  // opened_at (a non-null DATE).
  const LOANS_CSV =
    "loan_id,branch,balance,opened_at\n" +
    "1,north,1000.50,2026-07-01\n" +
    "2,south,,2026-07-02\n" +
    "3,north,750.25,2026-07-03\n";

  /** Land + load the fixture CSV so `raw.source` exists for the checks to run against. */
  async function loaded(): Promise<WarehouseStore> {
    const store = await openStore(":memory:");
    open.push(store);
    const dir = await mkdtemp(join(tmpdir(), "datastack-dq-"));
    tempDirs.push(dir);
    const csv = join(dir, "loans.csv");
    await writeFile(csv, LOANS_CSV);
    const land = await landParquet(store, {
      landingDir: join(dir, "landing"),
      sourcePath: csv,
      dataset: "loans",
      ingestionDate: "2026-07-17",
    });
    await loadWarehouse(store, { landingPath: land.landingPath });
    return store;
  }

  const PASSING_SPEC: DqSpec = {
    targetTable: "raw.source",
    checks: [
      { name: "rows present", type: "row_count", column: null, description: "at least one row" },
      { name: "id not null", type: "not_null", column: "loan_id", description: "loan_id not null" },
      { name: "branch present", type: "schema", column: "branch", description: "branch exists" },
      { name: "fresh", type: "freshness", column: "opened_at", description: "opened_at present" },
    ],
  };

  it("passes every check on a clean table and reports the aggregate as passed", async () => {
    const store = await loaded();

    const result = await runDqCheck(store, { spec: PASSING_SPEC });

    // Schema-valid, one result per check, aggregate passes → publish is allowed.
    expect(DqRunResultSchema.parse(result)).toEqual(result);
    expect(result.targetTable).toBe("raw.source");
    expect(result.results).toHaveLength(4);
    expect(result.results.every((r) => r.passed)).toBe(true);
    expect(result.passed).toBe(true);

    // Details carry the concrete metrics.
    const byName = new Map(result.results.map((r) => [r.name, r]));
    expect(byName.get("rows present")!.detail).toMatch(/3 row\(s\)/);
    expect(byName.get("id not null")!.detail).toMatch(/no NULLs in loan_id/);
    expect(byName.get("branch present")!.detail).toMatch(/branch present/);
    expect(byName.get("fresh")!.detail).toMatch(/non-null value\(s\) in opened_at/);
  });

  it("fails the not_null check on a column with a NULL, blocking publish", async () => {
    const store = await loaded();

    // Same shape, but the not_null check now targets `balance`, which has one NULL row.
    const spec: DqSpec = {
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
        { name: "fresh", type: "freshness", column: "opened_at", description: "opened_at present" },
      ],
    };

    const result = await runDqCheck(store, { spec });

    // The not_null check failed → the aggregate is false, which is what blocks publish (FR7).
    expect(result.passed).toBe(false);
    const failed = result.results.filter((r) => !r.passed);
    expect(failed.map((r) => r.name)).toEqual(["balance not null"]);
    expect(failed[0]!.detail).toMatch(/1 NULL\(s\) in balance/);
    // The other three checks still passed — one failure does not mask the rest.
    expect(result.results.filter((r) => r.passed)).toHaveLength(3);
  });

  it("fails a schema check for a column that is absent rather than passing it", async () => {
    const store = await loaded();

    const spec: DqSpec = {
      targetTable: "raw.source",
      checks: [
        { name: "rows present", type: "row_count", column: null, description: "at least one row" },
        { name: "id not null", type: "not_null", column: "loan_id", description: "loan_id not null" },
        {
          name: "missing column",
          type: "schema",
          column: "does_not_exist",
          description: "an absent column",
        },
        { name: "fresh", type: "freshness", column: "opened_at", description: "opened_at present" },
      ],
    };

    const result = await runDqCheck(store, { spec });

    expect(result.passed).toBe(false);
    const missing = result.results.find((r) => r.name === "missing column")!;
    expect(missing.passed).toBe(false);
    expect(missing.detail).toMatch(/does_not_exist missing/);
  });

  it("records a check that errors (unknown column) as failed instead of throwing", async () => {
    const store = await loaded();

    // A not_null check on a column that does not exist makes the query throw; the tool must record
    // it as a failed check, not abort the whole run.
    const spec: DqSpec = {
      targetTable: "raw.source",
      checks: [
        { name: "rows present", type: "row_count", column: null, description: "at least one row" },
        {
          name: "ghost not null",
          type: "not_null",
          column: "ghost",
          description: "a column that is not there",
        },
        { name: "branch present", type: "schema", column: "branch", description: "branch exists" },
        { name: "fresh", type: "freshness", column: "opened_at", description: "opened_at present" },
      ],
    };

    const result = await runDqCheck(store, { spec });

    expect(result.passed).toBe(false);
    const ghost = result.results.find((r) => r.name === "ghost not null")!;
    expect(ghost.passed).toBe(false);
    expect(ghost.detail).toMatch(/check errored:/);
  });
});
