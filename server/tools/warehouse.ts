import type { WarehouseStore } from "../store/duckdb.js";
import {
  DEFAULT_LOAD_SCHEMA,
  DEFAULT_LOAD_TABLE,
  isLoadSchema,
  LOAD_SCHEMAS,
  LoadResultSchema,
  safeTableName,
  type LoadResult,
  type LoadSchema,
} from "../core/warehouse.js";

/**
 * The `load_warehouse` tool (PRD FR5, ARCHITECTURE §5). It reads the Hive-partitioned Parquet the
 * land step wrote (`<landingPath>/**\/*.parquet`) and materializes it as a DuckDB table in the
 * `raw`/`staging` schema — the "Load Warehouse" pipeline stage. It is the second tool that writes
 * to the data plane, so it is permission **`ask`** (it is on {@link file://../opencode/config.ts}'s
 * `ASK_TOOLS`); the run pauses for human approval before it executes (FR8). An I/O module (DuckDB
 * `CREATE TABLE ... AS SELECT`), so it lives under `server/tools`; the pure parts — schema/table
 * validation, the result shape — are in {@link file://../core/warehouse.ts}.
 */

/** Inputs the `load_warehouse` tool needs to load one landed dataset into the warehouse. */
export interface LoadWarehouseInput {
  /** Landing-dataset root written by the land step (its `LandResult.landingPath`). */
  landingPath: string;
  /** Target schema — `raw` (default) or `staging`. Rejected if not an allowed load schema. */
  schema?: LoadSchema;
  /** Target table name; sanitized to a safe identifier. Defaults to `source`. */
  table?: string;
}

/** Escape a string for safe interpolation inside a single-quoted SQL literal. */
function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Escape a string for safe interpolation as a double-quoted SQL identifier. */
function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * Load the Parquet under `input.landingPath` into `<schema>.<table>`, replacing it if present.
 * The Parquet is read with `hive_partitioning=true` so the land step's `ingestion_date` partition
 * comes back as a column. The schema is validated against the closed {@link LOAD_SCHEMAS} set and
 * the table name is sanitized to a bare identifier and double-quoted, so neither can inject into
 * the DDL; the Parquet glob is a single-quoted literal (a table-function path cannot be a bound
 * parameter). The created table is read back with a plain `count(*)` so the returned
 * {@link LoadResult} reports what actually persisted, satisfying FR5's "records row count loaded".
 *
 * Throws if `schema` is not an allowed load target, or if no Parquet matches the glob (the
 * `read_parquet` error propagates) — the caller (T4.4 runner) maps those to a run-step failure.
 */
export async function loadWarehouse(
  store: WarehouseStore,
  input: LoadWarehouseInput,
): Promise<LoadResult> {
  const schema = input.schema ?? DEFAULT_LOAD_SCHEMA;
  if (!isLoadSchema(schema)) {
    throw new Error(
      `load_warehouse: invalid target schema "${schema}" (want one of ${LOAD_SCHEMAS.join(", ")})`,
    );
  }

  const table = safeTableName(input.table ?? DEFAULT_LOAD_TABLE);
  const qualifiedTable = `${schema}.${table}`;
  const target = `${schema}.${quoteIdent(table)}`;
  const glob = quoteLiteral(`${input.landingPath}/**/*.parquet`);

  // Materialize the landed Parquet as a warehouse table. CREATE OR REPLACE makes re-loading a
  // dataset idempotent (a re-run replaces the table rather than erroring on an existing name).
  await store.run(
    `CREATE OR REPLACE TABLE ${target} AS ` +
      `SELECT * FROM read_parquet(${glob}, hive_partitioning=true)`,
  );

  // Count rows by reading the created table back — proves the load persisted.
  const counted = await store.all(
    `SELECT count(*)::BIGINT AS row_count FROM ${target}`,
  );
  const rowCount = Number(counted[0]?.row_count ?? 0);

  return LoadResultSchema.parse({
    schema,
    table,
    qualifiedTable,
    landingPath: input.landingPath,
    rowCount,
  });
}
