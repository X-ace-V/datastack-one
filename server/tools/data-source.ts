import type { WarehouseStore } from "../store/duckdb.js";
import {
  isQueryableWorkspaceKind,
  type WorkspaceFileKind,
} from "../core/workspace.js";

/** Build a DuckDB table-function relation for a validated local data-file kind. */
export function dataSourceRelation(kind: string, pathExpression: string): string {
  if (!isQueryableWorkspaceKind(kind as WorkspaceFileKind)) {
    throw new Error(`source kind "${kind}" is not queryable`);
  }
  if (kind === "csv") return `read_csv_auto(${pathExpression})`;
  if (kind === "tsv") return `read_csv_auto(${pathExpression}, delim='\\t')`;
  if (kind === "json" || kind === "jsonl") return `read_json_auto(${pathExpression})`;
  if (kind === "parquet") return `read_parquet(${pathExpression})`;
  throw new Error(`source kind "${kind}" is not queryable`);
}

/** Validate a queryable upload/folder source by fully scanning it and return its row count. */
export async function loadDataRowCount(
  store: WarehouseStore,
  path: string,
  kind: string,
): Promise<number> {
  const rows = await store.all(
    `SELECT count(*)::BIGINT AS row_count FROM ${dataSourceRelation(kind, "?")}`,
    [path],
  );
  if (!rows[0]) throw new Error("data source scan returned no row count");
  return Number(rows[0].row_count);
}
