import type { WarehouseStore } from "./duckdb.js";
import { MARTS_SCHEMA } from "../core/transform.js";
import {
  ServedTableSchema,
  servedCsvEndpoint,
  servedEndpoint,
  type ServedTable,
  type ServingFormat,
} from "../core/serving.js";

/**
 * Persistence for the served-table registry (PRD FR10/FR12) in the DuckDB
 * `platform.served_tables` table — the record the `publish_serving` tool writes and the generated
 * `/api/serve/:name` endpoints (T5.3) resolve against. An I/O module by design (it wraps a
 * {@link WarehouseStore}), so it lives under `server/store`, not `server/core`. Every write binds
 * input through parameters ($1, $2, …); no field is concatenated into SQL. See ARCHITECTURE §3.4.
 */

/**
 * The column list every read selects. `published_at` is cast to VARCHAR so it arrives as a plain
 * string (`getRowObjects` otherwise returns a `DuckDBTimestampValue`) that
 * {@link ServedTableSchema} can validate directly.
 */
const SERVED_COLUMNS =
  "name, project_id, run_id, schema_name, table_name, format, row_count, csv_path, " +
  "CAST(published_at AS VARCHAR) AS published_at";

/**
 * Map a raw `platform.served_tables` row to a validated {@link ServedTable}, deriving the
 * qualified table name and both endpoint URLs from the stored fields rather than reading them
 * back from columns — so the URLs a client is handed always match the current route contract.
 */
function rowToServedTable(row: Record<string, unknown>): ServedTable {
  const name = String(row.name);
  const schema = String(row.schema_name);
  const table = String(row.table_name);
  return ServedTableSchema.parse({
    name,
    projectId: row.project_id,
    runId: row.run_id ?? null,
    schema,
    table,
    qualifiedTable: `${schema}.${table}`,
    format: row.format,
    // DuckDB returns BIGINT as bigint, so coerce for the schema's number check.
    rowCount: Number(row.row_count),
    csvPath: row.csv_path,
    endpoint: servedEndpoint(name),
    csvEndpoint: servedCsvEndpoint(name),
    publishedAt: row.published_at,
  });
}

/** Fields needed to register (or re-register) one served table. */
export interface RegisterServedTableInput {
  /** Served name — the endpoint's URL segment and the registry key. Sanitize before calling. */
  name: string;
  /** Project publishing the table. */
  projectId: string;
  /** Run that published it, or `null`/absent when published outside a run. */
  runId?: string | null;
  /** Unqualified name of the `marts` table being served. Sanitize before calling. */
  table: string;
  /** Export format generated at publish time. */
  format: ServingFormat;
  /** Rows served, counted from the table at publish time. */
  rowCount: number;
  /** On-disk path of the generated export. */
  csvPath: string;
}

/**
 * Register a served table and return it as persisted. Re-publishing an existing name **replaces**
 * that row (`ON CONFLICT (name) DO UPDATE`) and re-stamps `published_at`, keeping the registry's
 * one-row-per-endpoint invariant: a URL always resolves to exactly one table, the most recently
 * published one. The row is read back after the write rather than echoing the input, so the
 * caller sees what the table actually holds (including the `published_at` the engine stamped).
 */
export async function registerServedTable(
  store: WarehouseStore,
  input: RegisterServedTableInput,
): Promise<ServedTable> {
  await store.run(
    `INSERT INTO platform.served_tables
       (name, project_id, run_id, schema_name, table_name, format, row_count, csv_path)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (name) DO UPDATE SET
       project_id   = excluded.project_id,
       run_id       = excluded.run_id,
       schema_name  = excluded.schema_name,
       table_name   = excluded.table_name,
       format       = excluded.format,
       row_count    = excluded.row_count,
       csv_path     = excluded.csv_path,
       published_at = now()`,
    [
      input.name,
      input.projectId,
      input.runId ?? null,
      MARTS_SCHEMA,
      input.table,
      input.format,
      input.rowCount,
      input.csvPath,
    ],
  );

  const served = await getServedTable(store, input.name);
  if (!served) {
    throw new Error(`served table "${input.name}" was not found immediately after registering`);
  }
  return served;
}

/** Fetch the table registered under a served name, or `null` if the name is not registered. */
export async function getServedTable(
  store: WarehouseStore,
  name: string,
): Promise<ServedTable | null> {
  const rows = await store.all(
    `SELECT ${SERVED_COLUMNS} FROM platform.served_tables WHERE name = $1`,
    [name],
  );
  const row = rows[0];
  return row ? rowToServedTable(row) : null;
}
