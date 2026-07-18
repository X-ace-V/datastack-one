import type { WarehouseStore } from "../store/duckdb.js";
import { listSessionSources } from "../store/session-sources.js";
import {
  assertReadOnlySelect,
  buildQueryResult,
  type QueryResult,
} from "../core/query.js";

/**
 * The `run_query` tool (PRD FR7, ARCHITECTURE §3.4/§5). Executes a model-produced **read-only**
 * `SELECT` over DuckDB and returns the resulting rows to the data panel. Its permission is `allow`
 * — a validated SELECT cannot mutate data, so no approval gate is needed (unlike the write tools).
 *
 * An I/O module (it queries DuckDB), so it lives under `server/tools`, not `server/core`; the pure
 * read-only guard, row cap, and result shape live in {@link file://../core/query.ts}.
 *
 * The agent addresses a source by its **name** (FR5b): before running the query, each CSV source
 * connected to the session is exposed as a DuckDB view of that name (`… AS SELECT * FROM
 * read_csv_auto(<path>)`, the path bound as a parameter), so `SELECT … FROM <name>` resolves. The
 * warehouse's real `raw`/`staging`/`marts` tables are already queryable by their qualified names.
 *
 * The views live in `main` and are **dropped as soon as the query finishes** (a `finally`): the
 * {@link WarehouseStore} wraps ONE DuckDB connection (single-user localhost, ARCHITECTURE §1.4), so
 * a view left behind would let a later query — even from another session — resolve a bare source
 * name it never connected. Creating them per-call and tearing them down keeps each query scoped to
 * exactly the sources of its own session. (True simultaneous cross-session queries on one connection
 * are outside the single-user MVP; calls run sequentially here.)
 */

/** Double-quote a DuckDB identifier, escaping embedded quotes, so a source name can't inject. */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export async function runQuery(
  store: WarehouseStore,
  input: { sessionId: string; sql: string },
): Promise<QueryResult> {
  // Reject anything but a single read-only SELECT before touching the warehouse.
  const sql = assertReadOnlySelect(input.sql);

  // Expose each connected CSV source under its name so `FROM <name>` resolves; remember which
  // views were created so they can be dropped once the query has run.
  const sources = await listSessionSources(store, input.sessionId);
  const created: string[] = [];
  try {
    for (const source of sources) {
      if (source.kind !== "csv") continue;
      // A `?` parameter cannot be bound inside a CREATE VIEW (DuckDB rejects a prepared parameter
      // in DDL), so the backend-controlled path is single-quote-escaped into the SQL literal —
      // the same treatment the land/serve COPY destinations use. It is never model-produced.
      const pathLiteral = source.path.replace(/'/g, "''");
      await store.run(
        `CREATE OR REPLACE VIEW main.${quoteIdent(source.name)} AS ` +
          `SELECT * FROM read_csv_auto('${pathLiteral}')`,
      );
      created.push(source.name);
    }

    // DESCRIBE yields the columns + types authoritatively (even for a 0-row result); the SELECT
    // itself yields the rows. buildQueryResult caps the rows and flags a truncated result.
    const described = await store.all(`DESCRIBE ${sql}`);
    const columns = described.map((row) => ({
      name: String(row.column_name),
      type: String(row.column_type),
    }));

    const raw = await store.all(sql);
    return buildQueryResult(columns, raw);
  } finally {
    for (const name of created) {
      await store.run(`DROP VIEW IF EXISTS main.${quoteIdent(name)}`);
    }
  }
}
