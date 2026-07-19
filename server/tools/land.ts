import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { WarehouseStore } from "../store/duckdb.js";
import {
  formatIngestionDate,
  isIngestionDate,
  safeDatasetName,
  INGESTION_DATE_COLUMN,
  LandResultSchema,
  type LandResult,
} from "../core/landing.js";
import { dataSourceRelation } from "./data-source.js";

/**
 * The `land_parquet` tool (PRD FR4, ARCHITECTURE §5). It writes a connected queryable data file to
 * `data/landing/<dataset>/` as Parquet, partitioned by ingestion date via DuckDB's Hive layout
 * (`ingestion_date=YYYY-MM-DD/*.parquet`). This is the "Land Parquet" pipeline stage — the
 * first tool that touches the data plane by writing, so it is permission **`ask`** (it is on
 * {@link file://../opencode/config.ts}'s `ASK_TOOLS`); the run pauses for human approval before
 * it executes (FR8). An I/O module (fs + DuckDB `COPY`), so it lives under `server/tools`; the
 * pure parts — name sanitizing, date formatting, the result shape — are in
 * {@link file://../core/landing.ts}.
 */

/** Default landing root. `data/` is gitignored; the pipeline/tests point this at another dir. */
export const DEFAULT_LANDING_DIR = "data/landing";

/** Inputs the `land_parquet` tool needs to write one dataset's Parquet partition. */
export interface LandParquetInput {
  /** Landing root (e.g. `data/landing`). */
  landingDir: string;
  /** Backend-only path to the queryable uploaded/folder source to land. */
  sourcePath: string;
  /** Validated local data-file kind (csv/tsv/json/jsonl/parquet). */
  sourceKind?: string;
  /** Logical dataset name; sanitized to a safe directory basename before use. */
  dataset: string;
  /** Ingestion date `YYYY-MM-DD` to partition under; defaults to today (UTC) when omitted. */
  ingestionDate?: string;
}

/** Escape a string for safe interpolation inside a single-quoted SQL literal. */
function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Land the data file at `input.sourcePath` as Hive-partitioned Parquet under
 * `<landingDir>/<dataset>/ingestion_date=<date>/`. The source path and ingestion date are
 * bound as query parameters (never string-concatenated); the destination path — derived from
 * the server-controlled landing dir and the sanitized dataset name — is a single-quoted
 * literal (DuckDB's `COPY ... TO` target cannot be a bound parameter). The written Parquet is
 * read back to count the landed rows, so the returned {@link LandResult} reflects what actually
 * persisted rather than an echo of the input.
 *
 * Throws if `ingestionDate` is malformed or the source file cannot be read (the `COPY` error
 * propagates) — the caller (T4.4 runner) maps those to a run-step failure.
 */
export async function landParquet(
  store: WarehouseStore,
  input: LandParquetInput,
): Promise<LandResult> {
  const ingestionDate = input.ingestionDate ?? formatIngestionDate(new Date());
  if (!isIngestionDate(ingestionDate)) {
    throw new Error(`land_parquet: invalid ingestion date "${ingestionDate}" (want YYYY-MM-DD)`);
  }

  const dataset = safeDatasetName(input.dataset);
  const landingPath = join(input.landingDir, dataset);
  const partitionPath = join(landingPath, `${INGESTION_DATE_COLUMN}=${ingestionDate}`);

  // COPY does not create intermediate parent directories, so ensure the dataset root exists.
  await mkdir(landingPath, { recursive: true });

  // Add the ingestion-date partition column, then COPY out as Hive-partitioned Parquet.
  // OVERWRITE_OR_IGNORE makes re-landing the same date replace just that partition (idempotent
  // per run). The date and source path are bound; only the vetted destination is a literal.
  await store.run(
    `COPY (SELECT *, CAST(? AS DATE) AS ${INGESTION_DATE_COLUMN} FROM ` +
      `${dataSourceRelation(input.sourceKind ?? "csv", "?")}) ` +
      `TO ${quoteLiteral(landingPath)} ` +
      `(FORMAT PARQUET, PARTITION_BY (${INGESTION_DATE_COLUMN}), OVERWRITE_OR_IGNORE)`,
    [ingestionDate, input.sourcePath],
  );

  // Count rows by reading the landed Parquet back — proves the write persisted. A plain
  // count(*) avoids aggregating the Hive partition column (min/max over it hits a DuckDB
  // statistics-propagation bug).
  const glob = quoteLiteral(`${landingPath}/**/*.parquet`);
  const counted = await store.all(
    `SELECT count(*)::BIGINT AS row_count FROM read_parquet(${glob}, hive_partitioning=true)`,
  );
  const rowCount = Number(counted[0]?.row_count ?? 0);

  return LandResultSchema.parse({
    dataset,
    landingPath,
    ingestionDate,
    partitionPath,
    rowCount,
  });
}
