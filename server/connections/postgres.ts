import { DuckDBInstance } from "@duckdb/node-api";
import {
  redactConnectionSecret,
  type ConnectionTestResult,
  type ConnectionType,
} from "../core/connections.js";

/**
 * The server-side connection prober (PRD FR5, ARCHITECTURE §3.7). Given a resolved (secret) URL,
 * it verifies the backend can actually reach and open the database read-only — the honest
 * "Test connection" the Settings panel offers. It is an I/O module (DuckDB + network), so it
 * lives under `server/connections`, the same seam V5.2 will grow the name → URL ATTACH on.
 *
 * The MVP verb is Postgres/Neon: attach it via DuckDB's `postgres` extension, exactly as the
 * agent's `run_query` will span it (V5.2) — so a green test means the query path will work, not
 * just that a socket opened. The probe is **always `READ_ONLY`** (the hard rule: a registered
 * connection is never written) and runs on a throwaway in-memory DuckDB so it never mutates or
 * leaves an ATTACH on the real warehouse connection.
 */

/**
 * A function that tests whether a connection URL is reachable. Injected into the server as
 * `ServerDeps.testConnection` so route tests can supply a deterministic, offline stub while the
 * real boot wires {@link testConnection}. Takes the resolved URL + type; returns a scrubbed
 * result whose `error` never contains the secret.
 */
export type ConnectionTester = (
  url: string,
  type: ConnectionType,
) => Promise<ConnectionTestResult>;

/** The catalog alias the probe attaches under; detached again before the instance closes. */
const PROBE_ALIAS = "datastack_probe";

/**
 * Attempt a read-only Postgres attach and immediate detach. On success returns `{ok:true}`; on
 * any failure returns `{ok:false, error}` with the secret scrubbed out of the driver message
 * (the DuckDB Postgres driver echoes the full connection string, password included, into its
 * error text — {@link redactConnectionSecret} removes it before it can reach the client).
 */
export async function testPostgresConnection(
  url: string,
): Promise<ConnectionTestResult> {
  // A single-quote in the URL would break out of the ATTACH string literal; the destination of
  // an ATTACH cannot be a bound parameter (it is DDL), so escape it the same way the land/serve
  // COPY destinations are (double any quote). Backend-controlled at this point, but escaped
  // regardless so a crafted URL cannot inject SQL.
  const escaped = url.replace(/'/g, "''");
  let instance: DuckDBInstance | undefined;
  try {
    instance = await DuckDBInstance.create(":memory:");
    const connection = await instance.connect();
    try {
      await connection.run("INSTALL postgres;");
      await connection.run("LOAD postgres;");
      await connection.run(
        `ATTACH '${escaped}' AS ${PROBE_ALIAS} (TYPE postgres, READ_ONLY);`,
      );
      await connection.run(`DETACH ${PROBE_ALIAS};`);
      return { ok: true, error: null };
    } finally {
      connection.disconnectSync();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: redactConnectionSecret(message, url) };
  } finally {
    instance?.closeSync();
  }
}

/**
 * Test a connection by type. Postgres is the only MVP type; the dispatch leaves the seam for
 * others without the route needing to know the mechanism. This is the default
 * `ServerDeps.testConnection` wired at boot.
 */
export const testConnection: ConnectionTester = async (url, type) => {
  switch (type) {
    case "postgres":
      return testPostgresConnection(url);
    default:
      // Unreachable while `postgres` is the only ConnectionType, but keeps the dispatch total.
      return { ok: false, error: `unsupported connection type: ${type}` };
  }
};
