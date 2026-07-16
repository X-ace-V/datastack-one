import type { WarehouseStore } from "./duckdb.js";
import { SourceSchema, type Source } from "../core/sources.js";

/**
 * Persistence for uploaded sources (PRD FR2) in the DuckDB `platform.sources` table. An
 * I/O module by design — it wraps a {@link WarehouseStore} — so it lives under
 * `server/store`, not `server/core`. Every write binds user input through parameters
 * ($1, $2, …); no request field is ever concatenated into SQL. See ARCHITECTURE §3.4.
 */

/**
 * The column list every read selects. `created_at` is cast to VARCHAR so it arrives as a
 * plain string (`getRowObjects` otherwise returns a `DuckDBTimestampValue`) that
 * {@link SourceSchema} can validate directly.
 */
const SOURCE_COLUMNS =
  "id, project_id, kind, path, original_filename, row_count, " +
  "CAST(created_at AS VARCHAR) AS created_at";

/** Map a raw `platform.sources` row (snake_case, nullable, bigint count) to a {@link Source}. */
function rowToSource(row: Record<string, unknown>): Source {
  return SourceSchema.parse({
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    path: row.path,
    originalFilename: row.original_filename ?? null,
    // DuckDB returns BIGINT columns as bigint; the API contract is a plain number.
    rowCount: row.row_count == null ? null : Number(row.row_count),
    createdAt: row.created_at,
  });
}

/** Fields needed to record an uploaded source. `kind` defaults to `csv` (the only MVP kind). */
export interface InsertSourceInput {
  /** Application-generated source id (also used to name the file on disk). */
  id: string;
  /** Owning project. */
  projectId: string;
  /** On-disk path the raw upload was written to. */
  path: string;
  /** The client-supplied filename, or `null` if the stream arrived unnamed. */
  originalFilename: string | null;
  /** Source kind; defaults to `csv`. */
  kind?: string;
}

/**
 * Insert a source and return it as persisted. The id is caller-generated (it names the file
 * on disk); `created_at` and the `kind`/`row_count` defaults come from the table, so the row
 * is read back after the insert rather than echoing the input.
 */
export async function insertSource(
  store: WarehouseStore,
  input: InsertSourceInput,
): Promise<Source> {
  await store.run(
    `INSERT INTO platform.sources (id, project_id, kind, path, original_filename)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      input.id,
      input.projectId,
      input.kind ?? "csv",
      input.path,
      input.originalFilename ?? null,
    ],
  );

  const rows = await store.all(
    `SELECT ${SOURCE_COLUMNS} FROM platform.sources WHERE id = $1`,
    [input.id],
  );
  const row = rows[0];
  if (!row) {
    throw new Error(`source ${input.id} was not found immediately after insert`);
  }
  return rowToSource(row);
}

/** Fetch a single source by id, or `null` if none exists. */
export async function getSource(
  store: WarehouseStore,
  id: string,
): Promise<Source | null> {
  const rows = await store.all(
    `SELECT ${SOURCE_COLUMNS} FROM platform.sources WHERE id = $1`,
    [id],
  );
  const row = rows[0];
  return row ? rowToSource(row) : null;
}

/**
 * Record a source's profiled row count (T2.4, FR2). Uploading leaves `row_count` null until
 * the profile stage runs; this fills it in and returns the updated row, or `null` if the id
 * is unknown. The count binds as a parameter like every other write.
 */
export async function updateSourceRowCount(
  store: WarehouseStore,
  id: string,
  rowCount: number,
): Promise<Source | null> {
  await store.run(
    `UPDATE platform.sources SET row_count = $1 WHERE id = $2`,
    [rowCount, id],
  );
  return getSource(store, id);
}

/** List a project's sources, newest first (id breaks ties for a stable order). */
export async function listSources(
  store: WarehouseStore,
  projectId: string,
): Promise<Source[]> {
  const rows = await store.all(
    `SELECT ${SOURCE_COLUMNS} FROM platform.sources
     WHERE project_id = $1 ORDER BY created_at DESC, id`,
    [projectId],
  );
  return rows.map(rowToSource);
}
