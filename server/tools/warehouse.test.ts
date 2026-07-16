import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openStore, type WarehouseStore } from "../store/duckdb.js";
import { LoadResultSchema } from "../core/warehouse.js";
import { landParquet } from "./land.js";
import { loadWarehouse } from "./warehouse.js";

/**
 * Integration test for the `load_warehouse` tool (T4.2 / PRD FR5) against real DuckDB and a real
 * landing directory on disk. It lands a CSV as Parquet (the T4.1 seam), then loads it into the
 * `raw`/`staging` schema and asserts the desired result — the exact rows materialized into the
 * warehouse table, the reported row count matching what persisted, and `raw.source` reachable by
 * the transform/DQ stages. Pure helpers are covered in {@link file://../core/warehouse.test.ts}.
 */
describe("load_warehouse tool (Parquet → DuckDB raw/staging table)", () => {
  const open: WarehouseStore[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(open.splice(0).map((s) => s.close()));
    await Promise.all(
      tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
    );
  });

  // Synthetic lending source: a unique key, a dimension, a measure with one null.
  const LOANS_CSV =
    "loan_id,branch,balance\n" +
    "1,north,1000.50\n" +
    "2,south,\n" +
    "3,north,750.25\n";

  /** Land the fixture CSV as Parquet and return the store + the landing-dataset root. */
  async function landed(ingestionDate = "2026-07-17"): Promise<{
    store: WarehouseStore;
    landingPath: string;
  }> {
    const store = await openStore(":memory:");
    open.push(store);
    const dir = await mkdtemp(join(tmpdir(), "datastack-load-"));
    tempDirs.push(dir);
    const csv = join(dir, "loans.csv");
    await writeFile(csv, LOANS_CSV);
    const land = await landParquet(store, {
      landingDir: join(dir, "landing"),
      sourcePath: csv,
      dataset: "loans",
      ingestionDate,
    });
    return { store, landingPath: land.landingPath };
  }

  it("loads landed Parquet into raw.source with the exact rows and row count", async () => {
    const { store, landingPath } = await landed();

    const result = await loadWarehouse(store, { landingPath });

    // The returned result is schema-valid and reports what was loaded.
    expect(LoadResultSchema.parse(result)).toEqual(result);
    expect(result.schema).toBe("raw");
    expect(result.table).toBe("source");
    expect(result.qualifiedTable).toBe("raw.source");
    expect(result.landingPath).toBe(landingPath);
    expect(result.rowCount).toBe(3);

    // The table exists in raw with the source columns plus the added ingestion_date, exact rows.
    const rows = await store.all(
      `SELECT loan_id, branch, balance, ingestion_date::VARCHAR AS ingestion_date ` +
        `FROM raw.source ORDER BY loan_id`,
    );
    expect(rows).toEqual([
      { loan_id: 1n, branch: "north", balance: 1000.5, ingestion_date: "2026-07-17" },
      { loan_id: 2n, branch: "south", balance: null, ingestion_date: "2026-07-17" },
      { loan_id: 3n, branch: "north", balance: 750.25, ingestion_date: "2026-07-17" },
    ]);
  });

  it("loads into the staging schema and a custom table name when asked", async () => {
    const { store, landingPath } = await landed();

    const result = await loadWarehouse(store, {
      landingPath,
      schema: "staging",
      table: "loans_raw",
    });

    expect(result.schema).toBe("staging");
    expect(result.table).toBe("loans_raw");
    expect(result.qualifiedTable).toBe("staging.loans_raw");
    expect(result.rowCount).toBe(3);
    const staged = await store.all(
      `SELECT count(*)::BIGINT AS n FROM staging.loans_raw`,
    );
    expect(Number(staged[0]?.n)).toBe(3);
  });

  it("re-loading replaces the table (idempotent per run)", async () => {
    const { store, landingPath } = await landed();

    await loadWarehouse(store, { landingPath });
    const second = await loadWarehouse(store, { landingPath });

    // Row count stays 3 — CREATE OR REPLACE replaced the table rather than doubling it.
    expect(second.rowCount).toBe(3);
    const reloaded = await store.all(`SELECT count(*)::BIGINT AS n FROM raw.source`);
    expect(Number(reloaded[0]?.n)).toBe(3);
  });

  it("sanitizes an injection table name into a bare identifier in the target schema", async () => {
    const { store, landingPath } = await landed();

    const result = await loadWarehouse(store, {
      landingPath,
      table: "loans; DROP TABLE raw.source",
    });

    // The malicious name collapses to one safe identifier; nothing was dropped.
    expect(result.table).toBe("loans__DROP_TABLE_raw_source");
    expect(result.qualifiedTable).toBe("raw.loans__DROP_TABLE_raw_source");
    const safeLoaded = await store.all(
      `SELECT count(*)::BIGINT AS n FROM raw."loans__DROP_TABLE_raw_source"`,
    );
    expect(Number(safeLoaded[0]?.n)).toBe(3);
  });

  it("rejects a schema outside raw/staging", async () => {
    const { store, landingPath } = await landed();
    await expect(
      // Force an invalid schema past the type to prove the runtime guard holds.
      loadWarehouse(store, { landingPath, schema: "marts" as never }),
    ).rejects.toThrow(/invalid target schema/);
  });

  it("throws when no Parquet matches the landing path", async () => {
    const { store } = await landed();
    await expect(
      loadWarehouse(store, { landingPath: "/tmp/datastack-nonexistent-landing" }),
    ).rejects.toThrow();
  });
});
