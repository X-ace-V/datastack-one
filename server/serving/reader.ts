import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { Readable } from "node:stream";
import type { WarehouseStore } from "../store/duckdb.js";
import {
  ServedDataSchema,
  toJsonCell,
  type ServedColumn,
  type ServedData,
  type ServedQuery,
  type ServedTable,
} from "../core/serving.js";

/**
 * Read side of the generated serving endpoints (PRD FR10, ARCHITECTURE §9) — what
 * `GET /api/serve/:name` and `GET /api/serve/:name.csv` resolve a registered served name to.
 * The registry lookup itself lives in {@link file://../store/serving.ts}; this module turns a
 * registry row into the data behind it.
 *
 * **Served data is read from the published CSV export, not from the live `marts` table.** That is
 * deliberate. The export is the snapshot that passed the DQ stage and that a human approved at the
 * publish gate (FR7/FR8), so reading it is what keeps those gates meaningful: a later run whose
 * transform succeeded but whose DQ *failed* leaves new rows in `marts` and never publishes, and
 * serving `marts` live would hand exactly that un-published, DQ-failed data to REST callers. It
 * also means the two endpoints can never disagree — the JSON preview and the CSV download are the
 * same bytes — and that paging is stable, since a file has a fixed row order where the transform's
 * `GROUP BY` (no `ORDER BY`) does not.
 *
 * An I/O module (fs + DuckDB), so it lives outside the pure `server/core`, which owns the
 * response shape, the page bounds, and the cell coercion.
 */

/**
 * Raised when a name is registered but its published export is gone from disk (`data/` is
 * disposable — it is gitignored and can be cleared between runs). The registry still claims the
 * endpoint, so this is not a 404; the route reports it as `410 Gone`, naming the missing file.
 */
export class ServedExportMissingError extends Error {
  constructor(readonly served: ServedTable) {
    super(
      `the published export for served table "${served.name}" is missing at ${served.csvPath} — ` +
        `re-run the pipeline's publish stage to regenerate it`,
    );
    this.name = "ServedExportMissingError";
  }
}

/**
 * Assert the published export exists, returning its size. Both endpoints check this before doing
 * any work, so a missing export fails as one clear error rather than as a DuckDB read failure on
 * the JSON path and a stream error on the CSV path.
 */
async function requireExport(served: ServedTable): Promise<number> {
  try {
    const stats = await stat(served.csvPath);
    if (!stats.isFile()) throw new ServedExportMissingError(served);
    return stats.size;
  } catch (err) {
    if (err instanceof ServedExportMissingError) throw err;
    throw new ServedExportMissingError(served);
  }
}

/**
 * Read a page of a served table plus its columns and total row count (FR10). The export path is
 * bound as a query parameter — `read_csv_auto(?)` accepts one — so nothing is concatenated into
 * SQL, and every cell passes through {@link toJsonCell} so `BIGINT`/`DATE`/`TIMESTAMP`/`DECIMAL`
 * values survive JSON serialization.
 *
 * Throws {@link ServedExportMissingError} when the published export is no longer on disk.
 */
export async function readServedData(
  store: WarehouseStore,
  served: ServedTable,
  query: ServedQuery,
): Promise<ServedData> {
  await requireExport(served);

  const described = await store.all(`DESCRIBE SELECT * FROM read_csv_auto(?)`, [served.csvPath]);
  const columns: ServedColumn[] = described.map((row) => ({
    name: String(row.column_name),
    type: String(row.column_type),
  }));

  // The total behind the endpoint, counted from the export itself rather than trusted from the
  // registry's publish-time count — the response then describes the file it actually read.
  const counted = await store.all(
    `SELECT count(*)::BIGINT AS row_count FROM read_csv_auto(?)`,
    [served.csvPath],
  );
  const rowCount = Number(counted[0]?.row_count ?? 0);

  const rows = await store.all(`SELECT * FROM read_csv_auto(?) LIMIT ? OFFSET ?`, [
    served.csvPath,
    query.limit,
    query.offset,
  ]);

  return ServedDataSchema.parse({
    name: served.name,
    schema: served.schema,
    table: served.table,
    qualifiedTable: served.qualifiedTable,
    format: served.format,
    endpoint: served.endpoint,
    csvEndpoint: served.csvEndpoint,
    publishedAt: served.publishedAt,
    columns,
    rowCount,
    rows: rows.map((row) =>
      Object.fromEntries(Object.entries(row).map(([key, value]) => [key, toJsonCell(value)])),
    ),
    limit: query.limit,
    offset: query.offset,
  });
}

/**
 * Open the published CSV export for download (FR10: "downloadable (CSV)"), returning a stream of
 * the file and its size so the response can carry an honest `content-length`. Streamed rather than
 * buffered so a large export does not have to fit in memory to be served.
 *
 * Throws {@link ServedExportMissingError} when the published export is no longer on disk.
 */
export async function openServedCsv(
  served: ServedTable,
): Promise<{ stream: Readable; size: number }> {
  const size = await requireExport(served);
  return { stream: createReadStream(served.csvPath), size };
}
