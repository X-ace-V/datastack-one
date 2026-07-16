import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openStore, type WarehouseStore } from "../store/duckdb.js";
import {
  formatIngestionDate,
  isIngestionDate,
  LandResultSchema,
} from "../core/landing.js";
import { landParquet } from "./land.js";

/**
 * Integration test for the `land_parquet` tool (T4.1 / PRD FR4) against real DuckDB `COPY` and
 * a real landing directory on disk. It asserts the desired result — Parquet written under a
 * Hive `ingestion_date=<date>` partition, an `ingestion_date` column added, and the exact rows
 * readable back — not merely that the call returns. Pure helpers are covered in
 * {@link file://../core/landing.test.ts}.
 */
describe("land_parquet tool (DuckDB COPY → partitioned Parquet)", () => {
  const open: WarehouseStore[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(open.splice(0).map((s) => s.close()));
    await Promise.all(
      tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
    );
  });

  async function fixtures(): Promise<{ store: WarehouseStore; dir: string; csv: string }> {
    const store = await openStore(":memory:");
    open.push(store);
    const dir = await mkdtemp(join(tmpdir(), "datastack-land-"));
    tempDirs.push(dir);
    const csv = join(dir, "loans.csv");
    await writeFile(csv, LOANS_CSV);
    return { store, dir, csv };
  }

  // Synthetic lending source: a unique key, a dimension, a measure with one null.
  const LOANS_CSV =
    "loan_id,branch,balance\n" +
    "1,north,1000.50\n" +
    "2,south,\n" +
    "3,north,750.25\n";

  /** Read the landed dataset back through DuckDB, newest partition and all, ordered by key. */
  async function readLanded(store: WarehouseStore, landingPath: string) {
    const glob = `'${landingPath}/**/*.parquet'`;
    return store.all(
      `SELECT loan_id, branch, ingestion_date::VARCHAR AS ingestion_date ` +
        `FROM read_parquet(${glob}, hive_partitioning=true) ORDER BY loan_id`,
    );
  }

  it("lands the CSV as Hive-partitioned Parquet under the ingestion date", async () => {
    const { store, dir, csv } = await fixtures();
    const landingDir = join(dir, "landing");

    const result = await landParquet(store, {
      landingDir,
      sourcePath: csv,
      dataset: "loans",
      ingestionDate: "2026-07-17",
    });

    // The returned result is schema-valid and reports what was written.
    expect(LandResultSchema.parse(result)).toEqual(result);
    expect(result.dataset).toBe("loans");
    expect(result.ingestionDate).toBe("2026-07-17");
    expect(result.rowCount).toBe(3);
    expect(result.landingPath).toBe(join(landingDir, "loans"));
    expect(result.partitionPath).toBe(
      join(landingDir, "loans", "ingestion_date=2026-07-17"),
    );

    // The Hive partition directory exists on disk with at least one Parquet file.
    const partitions = await readdir(result.landingPath);
    expect(partitions).toContain("ingestion_date=2026-07-17");
    const files = await readdir(result.partitionPath);
    expect(files.some((f) => f.endsWith(".parquet"))).toBe(true);

    // Reading the Parquet back yields the exact rows plus the added ingestion_date column.
    const rows = await readLanded(store, result.landingPath);
    expect(rows).toEqual([
      { loan_id: 1n, branch: "north", ingestion_date: "2026-07-17" },
      { loan_id: 2n, branch: "south", ingestion_date: "2026-07-17" },
      { loan_id: 3n, branch: "north", ingestion_date: "2026-07-17" },
    ]);
  });

  it("defaults the ingestion date to today (UTC) when omitted", async () => {
    const { store, dir, csv } = await fixtures();
    const landingDir = join(dir, "landing");

    const result = await landParquet(store, {
      landingDir,
      sourcePath: csv,
      dataset: "loans",
    });

    expect(isIngestionDate(result.ingestionDate)).toBe(true);
    expect(result.ingestionDate).toBe(formatIngestionDate(new Date()));
    // The partition directory the result names actually exists.
    await expect(stat(result.partitionPath)).resolves.toBeDefined();
  });

  it("re-landing the same date overwrites the partition (idempotent per run)", async () => {
    const { store, dir, csv } = await fixtures();
    const landingDir = join(dir, "landing");
    const args = { landingDir, sourcePath: csv, dataset: "loans", ingestionDate: "2026-07-17" };

    await landParquet(store, args);
    const second = await landParquet(store, args);

    // Row count stays 3 — the second write replaced the partition rather than doubling it.
    expect(second.rowCount).toBe(3);
    const rows = await readLanded(store, second.landingPath);
    expect(rows).toHaveLength(3);
  });

  it("sanitizes a traversal dataset name so the write stays under the landing dir", async () => {
    const { store, dir, csv } = await fixtures();
    const landingDir = join(dir, "landing");

    const result = await landParquet(store, {
      landingDir,
      sourcePath: csv,
      dataset: "../../escape",
      ingestionDate: "2026-07-17",
    });

    expect(result.dataset).toBe("escape");
    expect(result.landingPath).toBe(join(landingDir, "escape"));
    expect(result.landingPath).not.toContain("..");
    // The dataset directory is a direct child of the landing dir — nothing escaped.
    expect(await readdir(landingDir)).toEqual(["escape"]);
  });

  it("throws on an invalid ingestion date", async () => {
    const { store, dir, csv } = await fixtures();
    await expect(
      landParquet(store, {
        landingDir: join(dir, "landing"),
        sourcePath: csv,
        dataset: "loans",
        ingestionDate: "2026/07/17",
      }),
    ).rejects.toThrow(/invalid ingestion date/);
  });

  it("throws when the source CSV does not exist", async () => {
    const { store, dir } = await fixtures();
    await expect(
      landParquet(store, {
        landingDir: join(dir, "landing"),
        sourcePath: join(dir, "does-not-exist.csv"),
        dataset: "loans",
        ingestionDate: "2026-07-17",
      }),
    ).rejects.toThrow();
  });
});
