import type { WarehouseStore } from "../store/duckdb.js";
import {
  buildSourceProfile,
  type RawColumnStat,
  type SourceProfile,
} from "../core/profile.js";
import { dataSourceRelation } from "./data-source.js";

/**
 * The `profile_source` tool (PRD FR2, ARCHITECTURE §5). Read-only: it profiles a CSV via
 * DuckDB `read_csv_auto` — inferring schema, types, row count, null %, candidate primary
 * keys and date columns — without writing anything, so its permission is `allow`.
 *
 * An I/O module (it queries DuckDB), so it lives under `server/tools`, not `server/core`.
 * The classification is delegated to the pure {@link buildSourceProfile}; this module only
 * gathers the raw counts. Column identifiers come from the CSV header (user data), so every
 * one is double-quoted before it reaches SQL — the file path is bound as a parameter.
 */

/** A single row of DuckDB's `DESCRIBE` output: column name + inferred type. */
interface DescribedColumn {
  name: string;
  type: string;
}

/** Double-quote a DuckDB identifier, escaping embedded quotes, so a CSV header can't inject. */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Profile the CSV at `path`. Reads the file twice: once to `DESCRIBE` the columns and their
 * inferred types, once to aggregate the row count and each column's null and distinct counts
 * in a single pass. Returns a validated {@link SourceProfile}.
 *
 * Throws if the CSV has no columns or cannot be read (`read_csv_auto` errors propagate) —
 * the caller (T2.4 route) maps those to an HTTP response.
 */
export async function profileSource(
  store: WarehouseStore,
  path: string,
  kind: string = "csv",
): Promise<SourceProfile> {
  const relation = dataSourceRelation(kind, "?");
  const described = await store.all(
    `DESCRIBE SELECT * FROM ${relation}`,
    [path],
  );
  const columns: DescribedColumn[] = described.map((row) => ({
    name: String(row.column_name),
    type: String(row.column_type),
  }));
  if (columns.length === 0) {
    throw new Error(`profile_source: no columns found in CSV at ${path}`);
  }

  // One aggregate pass: total rows plus per-column null and distinct counts. Column names
  // are quoted (untrusted header); the aliases are index-based and safe.
  const selectParts = ["count(*)::BIGINT AS row_count"];
  columns.forEach((column, index) => {
    const ident = quoteIdent(column.name);
    selectParts.push(`count(*) - count(${ident}) AS null_${index}`);
    selectParts.push(`count(DISTINCT ${ident}) AS distinct_${index}`);
  });

  const aggregated = await store.all(
    `SELECT ${selectParts.join(", ")} FROM ${relation}`,
    [path],
  );
  const row = aggregated[0];
  if (!row) {
    throw new Error(`profile_source: aggregate query returned no row for ${path}`);
  }

  const rowCount = Number(row.row_count);
  const stats: RawColumnStat[] = columns.map((column, index) => ({
    name: column.name,
    type: column.type,
    nullCount: Number(row[`null_${index}`]),
    distinctCount: Number(row[`distinct_${index}`]),
  }));

  return buildSourceProfile(rowCount, stats);
}
