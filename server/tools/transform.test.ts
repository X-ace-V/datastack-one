import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openStore, type WarehouseStore } from "../store/duckdb.js";
import { RunTransformResultSchema } from "../core/transform.js";
import { safeTableName } from "../core/warehouse.js";
import { landParquet } from "./land.js";
import { loadWarehouse } from "./warehouse.js";
import { runTransform } from "./transform.js";

/**
 * Integration test for the `run_transform` tool (T4.3 / PRD FR6) against real DuckDB. It lands a
 * CSV, loads it into `raw.source` (the T4.1/T4.2 seam), then executes a reviewed transform SQL
 * and asserts the desired result — the exact aggregated rows materialized into `marts`, the
 * reported row count matching what persisted, idempotent re-runs, and that a crafted target-table
 * name cannot inject into the read-back. Pure helpers are covered in
 * {@link file://../core/transform.test.ts}.
 */
describe("run_transform tool (reviewed SQL → marts table)", () => {
  const open: WarehouseStore[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(open.splice(0).map((s) => s.close()));
    await Promise.all(
      tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
    );
  });

  // Synthetic lending source: a branch dimension and a balance measure with one null.
  const LOANS_CSV =
    "loan_id,branch,balance\n" +
    "1,north,1000.50\n" +
    "2,south,\n" +
    "3,north,750.25\n";

  /** Land + load the fixture CSV so `raw.source` exists for the transform to read. */
  async function loaded(): Promise<WarehouseStore> {
    const store = await openStore(":memory:");
    open.push(store);
    const dir = await mkdtemp(join(tmpdir(), "datastack-transform-"));
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

  // The exact shape the transform stage generates (see T3.3 PROGRESS line): null balances
  // coalesced to zero, aggregated per branch into a marts table.
  const TRANSFORM_SQL =
    "CREATE OR REPLACE TABLE marts.branch_balance_totals AS " +
    "SELECT branch, SUM(COALESCE(balance, 0)) AS total_balance " +
    "FROM raw.source GROUP BY branch";

  it("executes the reviewed SQL and materializes the exact marts rows", async () => {
    const store = await loaded();

    const result = await runTransform(store, {
      sql: TRANSFORM_SQL,
      targetTable: "branch_balance_totals",
    });

    // The result is schema-valid and reports what was created.
    expect(RunTransformResultSchema.parse(result)).toEqual(result);
    expect(result.schema).toBe("marts");
    expect(result.table).toBe("branch_balance_totals");
    expect(result.qualifiedTable).toBe("marts.branch_balance_totals");
    expect(result.rowCount).toBe(2);

    // The marts table holds the correct aggregation — north = 1000.50 + 750.25, south = 0
    // (the null balance was coalesced to zero).
    const rows = await store.all(
      `SELECT branch, total_balance FROM marts.branch_balance_totals ORDER BY branch`,
    );
    expect(rows).toEqual([
      { branch: "north", total_balance: 1750.75 },
      { branch: "south", total_balance: 0 },
    ]);
  });

  it("re-running the transform replaces the table (idempotent per run)", async () => {
    const store = await loaded();

    await runTransform(store, {
      sql: TRANSFORM_SQL,
      targetTable: "branch_balance_totals",
    });
    const second = await runTransform(store, {
      sql: TRANSFORM_SQL,
      targetTable: "branch_balance_totals",
    });

    // CREATE OR REPLACE replaced the table rather than doubling the branch rows.
    expect(second.rowCount).toBe(2);
    const counted = await store.all(
      `SELECT count(*)::BIGINT AS n FROM marts.branch_balance_totals`,
    );
    expect(Number(counted[0]?.n)).toBe(2);
  });

  it("sanitizes a crafted target-table name without injecting into the read-back", async () => {
    const store = await loaded();
    const dirty = 'totals"; DROP TABLE raw.source; --';
    const clean = safeTableName(dirty);

    // The reviewed SQL creates the sanitized-name table; run_transform reads it back safely.
    const result = await runTransform(store, {
      sql: `CREATE OR REPLACE TABLE marts.${JSON.stringify(clean)} AS SELECT 1 AS x`,
      targetTable: dirty,
    });

    expect(result.table).toBe(clean);
    expect(result.qualifiedTable).toBe(`marts.${clean}`);
    expect(result.rowCount).toBe(1);

    // raw.source was not dropped — the crafted name never reached SQL as executable text.
    const survived = await store.all(`SELECT count(*)::BIGINT AS n FROM raw.source`);
    expect(Number(survived[0]?.n)).toBe(3);
  });

  it("refuses to execute empty transform SQL", async () => {
    const store = await loaded();
    await expect(
      runTransform(store, { sql: "   ", targetTable: "branch_balance_totals" }),
    ).rejects.toThrow(/empty transform SQL/);
  });

  it("propagates a DuckDB error when the SQL fails to execute", async () => {
    const store = await loaded();
    await expect(
      runTransform(store, {
        sql: "CREATE OR REPLACE TABLE marts.broken AS SELECT * FROM raw.nonexistent",
        targetTable: "broken",
      }),
    ).rejects.toThrow();
  });

  it("throws when the reviewed SQL did not create marts.<targetTable>", async () => {
    const store = await loaded();
    // The SQL runs fine but writes to a different table than the declared target, so the
    // read-back from marts.<targetTable> fails — the tool never reports a false success.
    await expect(
      runTransform(store, {
        sql: "CREATE OR REPLACE TABLE marts.actual AS SELECT 1 AS x",
        targetTable: "declared",
      }),
    ).rejects.toThrow();
  });
});
