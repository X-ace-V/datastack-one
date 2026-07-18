import type { WarehouseStore } from "./duckdb.js";
import {
  ConnectionSchema,
  StoredConnectionSchema,
  type Connection,
  type ConnectionType,
  type StoredConnection,
} from "../core/connections.js";

/**
 * Persistence for the registered database connections (PRD FR5) in the DuckDB
 * `platform.connections` table. An I/O module (it wraps a {@link WarehouseStore}), so it lives
 * under `server/store`. Every write binds the URL secret through a parameter ($1, $2, …); it is
 * never concatenated into SQL. Two read paths exist by design: {@link listConnections} feeds the
 * client and DELIBERATELY does not select `url`, while {@link getStoredConnection} returns the
 * URL for the backend-only test/attach path (FR5b). See ARCHITECTURE §3.7.
 */

/**
 * The safe read: `url` is intentionally excluded from the SELECT so a leak is impossible at the
 * source, not merely filtered afterwards. `created_at` is cast to VARCHAR so it arrives as a
 * plain string {@link ConnectionSchema} can validate (raw it is a `DuckDBTimestampValue`).
 */
const CONNECTION_VIEW_COLUMNS =
  "name, type, CAST(created_at AS VARCHAR) AS created_at";

/** The backend-only read: the view columns plus the secret `url`. */
const STORED_CONNECTION_COLUMNS =
  "name, type, url, CAST(created_at AS VARCHAR) AS created_at";

/** Fields needed to register a connection. */
export interface AddConnectionInput {
  /** The agent-facing handle + future ATTACH alias (validated as an identifier by core). */
  name: string;
  /** The database type; `postgres` in the MVP. */
  type: ConnectionType;
  /** The credentialed connection URL — the secret, stored only here. */
  url: string;
}

/**
 * Register (or replace) a connection and return it as persisted, INCLUDING the secret url. The
 * registry is keyed by `name`, so re-adding a name updates its url/type and re-stamps
 * `created_at` (a re-entered credential replaces the old one). The row is read back after the
 * upsert so the table defaults are what the caller sees. Callers that answer the client must
 * project the result through `toConnectionView` first — this returns the stored (secret) shape.
 */
export async function addConnection(
  store: WarehouseStore,
  input: AddConnectionInput,
): Promise<StoredConnection> {
  await store.run(
    `INSERT INTO platform.connections (name, type, url)
     VALUES ($1, $2, $3)
     ON CONFLICT (name) DO UPDATE SET
       type = excluded.type,
       url = excluded.url,
       created_at = now()`,
    [input.name, input.type, input.url],
  );

  const stored = await getStoredConnection(store, input.name);
  if (!stored) {
    throw new Error(
      `connection ${input.name} was not found immediately after upsert`,
    );
  }
  return stored;
}

/**
 * List all connections as secret-free {@link Connection} views, newest first (name breaks ties
 * for a stable order). The url column is never selected, so this read cannot leak a credential.
 */
export async function listConnections(
  store: WarehouseStore,
): Promise<Connection[]> {
  const rows = await store.all(
    `SELECT ${CONNECTION_VIEW_COLUMNS} FROM platform.connections
     ORDER BY created_at DESC, name`,
  );
  return rows.map((row) =>
    ConnectionSchema.parse({
      name: row.name,
      type: row.type,
      createdAt: row.created_at,
    }),
  );
}

/**
 * Fetch one connection INCLUDING its secret url, or `null` if none is registered under `name`.
 * Backend-only — used to test a connection and (V5.2) to resolve name → url for `ATTACH`. Never
 * hand the result to the client without projecting it to a view first.
 */
export async function getStoredConnection(
  store: WarehouseStore,
  name: string,
): Promise<StoredConnection | null> {
  const rows = await store.all(
    `SELECT ${STORED_CONNECTION_COLUMNS} FROM platform.connections WHERE name = $1`,
    [name],
  );
  const row = rows[0];
  if (!row) return null;
  return StoredConnectionSchema.parse({
    name: row.name,
    type: row.type,
    url: row.url,
    createdAt: row.created_at,
  });
}

/**
 * Delete a connection by name. Returns `true` if a row existed and was removed, `false` if no
 * connection was registered under that name (so the route can answer 404 vs 200). Existence is
 * checked first because DuckDB's `run` does not surface an affected-row count.
 */
export async function deleteConnection(
  store: WarehouseStore,
  name: string,
): Promise<boolean> {
  const existing = await getStoredConnection(store, name);
  if (!existing) return false;
  await store.run("DELETE FROM platform.connections WHERE name = $1", [name]);
  return true;
}
