import type { WarehouseStore } from "./duckdb.js";
import { SessionSourceSchema, type SessionSource } from "../core/session-sources.js";

/**
 * Persistence for the per-session data-source registry (PRD FR4) in the DuckDB
 * `platform.session_sources` table. An I/O module — it wraps a {@link WarehouseStore} — so it
 * lives under `server/store`. Every write binds user input through parameters ($1, $2, …); no
 * request field is ever concatenated into SQL. The upload route (V3.2) registers sources here;
 * the `list_sources`/`profile_source` tools read them. See ARCHITECTURE §3.4.
 */

/**
 * The column list every read selects. `created_at` is cast to VARCHAR so it arrives as a plain
 * string (`getRowObjects` otherwise returns a `DuckDBTimestampValue`) that
 * {@link SessionSourceSchema} can validate directly.
 */
const SESSION_SOURCE_COLUMNS =
  "session_id, name, kind, path, row_count, " +
  "CAST(created_at AS VARCHAR) AS created_at";

/** Map a raw `platform.session_sources` row (snake_case, bigint count) to a {@link SessionSource}. */
function rowToSessionSource(row: Record<string, unknown>): SessionSource {
  return SessionSourceSchema.parse({
    sessionId: row.session_id,
    name: row.name,
    kind: row.kind,
    path: row.path,
    // DuckDB returns BIGINT columns as bigint; the contract is a plain number.
    rowCount: row.row_count == null ? null : Number(row.row_count),
    createdAt: row.created_at,
  });
}

/** Fields needed to register a source in a session. `kind` defaults to `csv` (the only MVP kind). */
export interface RegisterSessionSourceInput {
  /** OpenCode session id the source is connected to. */
  sessionId: string;
  /** The name the agent addresses the source by (unique within the session). */
  name: string;
  /** Backend-only path the raw data lives at; never exposed to the model. */
  path: string;
  /** Source kind; defaults to `csv`. */
  kind?: string;
  /** Profiled row count, if already known; null (the default) until profiling runs. */
  rowCount?: number | null;
}

/**
 * Register (or re-register) a source in a session and return it as persisted. The registry is
 * keyed by (session_id, name), so registering the same name again replaces the row — the
 * conflict target updates path/kind/row_count and re-stamps `created_at`. The row is read back
 * after the upsert so the table defaults (kind, created_at) are what the caller sees.
 */
export async function registerSessionSource(
  store: WarehouseStore,
  input: RegisterSessionSourceInput,
): Promise<SessionSource> {
  await store.run(
    `INSERT INTO platform.session_sources (session_id, name, kind, path, row_count)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (session_id, name) DO UPDATE SET
       kind = excluded.kind,
       path = excluded.path,
       row_count = excluded.row_count,
       created_at = now()`,
    [
      input.sessionId,
      input.name,
      input.kind ?? "csv",
      input.path,
      input.rowCount ?? null,
    ],
  );

  const source = await getSessionSource(store, input.sessionId, input.name);
  if (!source) {
    throw new Error(
      `session source ${input.sessionId}/${input.name} was not found immediately after upsert`,
    );
  }
  return source;
}

/** Fetch a single source by (session, name), or `null` if none is registered under that name. */
export async function getSessionSource(
  store: WarehouseStore,
  sessionId: string,
  name: string,
): Promise<SessionSource | null> {
  const rows = await store.all(
    `SELECT ${SESSION_SOURCE_COLUMNS} FROM platform.session_sources
     WHERE session_id = $1 AND name = $2`,
    [sessionId, name],
  );
  const row = rows[0];
  return row ? rowToSessionSource(row) : null;
}

/** List a session's sources, newest first (name breaks ties for a stable order). */
export async function listSessionSources(
  store: WarehouseStore,
  sessionId: string,
): Promise<SessionSource[]> {
  const rows = await store.all(
    `SELECT ${SESSION_SOURCE_COLUMNS} FROM platform.session_sources
     WHERE session_id = $1 ORDER BY created_at DESC, name`,
    [sessionId],
  );
  return rows.map(rowToSessionSource);
}
