import type { WarehouseStore } from "../store/duckdb.js";
import { loadDataRowCount } from "./data-source.js";

/**
 * Confirm an uploaded CSV is loadable in DuckDB and return its row count (PRD FR4, V3.2). The
 * upload route calls this once, right after the file lands on disk, so a file DuckDB cannot read
 * is rejected at upload time (the route maps a throw to 422) rather than surfacing later when the
 * agent tries to profile or query it. `count(*)` forces a full `read_csv_auto` scan — the same
 * reader `profile_source`/`run_query` use — so "loadable" here means genuinely loadable there.
 *
 * An I/O module (it queries DuckDB), so it lives under `server/tools`, not `server/core`. The
 * path is bound as a query parameter (`read_csv_auto(?)`), never concatenated into SQL.
 */
export async function loadCsvRowCount(
  store: WarehouseStore,
  path: string,
): Promise<number> {
  return loadDataRowCount(store, path, "csv");
}
