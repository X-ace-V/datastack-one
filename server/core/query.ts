import { z } from "zod";
import { ServedCellSchema, toJsonCell } from "./serving.js";

/**
 * Pure contract + validation for the `run_query` tool (PRD FR7, ARCHITECTURE §3.4). The agent
 * asks a read-only question of the connected data in natural language; the model turns it into a
 * SQL `SELECT`, and `run_query` executes it over DuckDB and returns rows to the data panel. This
 * module stays pure (no fs/net/process): it owns the read-only guard, the row cap, and the
 * JSON-safe result shape, so the guard can be unit-tested in isolation and the shape reused by the
 * tool, the loopback route, and the web mirror. The I/O (registering source views + running the
 * SQL) lives in `server/tools/query.ts`.
 *
 * Re-uses {@link toJsonCell}/{@link ServedCellSchema} from the serving contract so a queried cell
 * is coerced to JSON exactly like a served cell — DuckDB hands back `bigint`/date/decimal value
 * objects that `JSON.stringify` cannot carry as-is (see {@link toJsonCell}).
 */

/**
 * The most rows `run_query` returns to the panel. A conversational preview does not need an
 * unbounded result; a query returning more rows than this is reported as {@link QueryResult.truncated}
 * so the UI can say so rather than silently implying the whole table came back.
 */
export const MAX_QUERY_ROWS = 1000;

/** Raised when a submitted query is not a single read-only `SELECT` (the route maps it to 422). */
export class NonReadOnlyQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonReadOnlyQueryError";
  }
}

/**
 * Strip string/identifier literals and comments from SQL so the read-only checks below can scan
 * the statement's *structure* without a `;` or a keyword hiding inside a string value or a quoted
 * identifier tripping a false positive (e.g. `WHERE note = 'a;b'`). Quoted spans collapse to a
 * single space; `--` line comments and `/* *\/` block comments are removed. This is a lexical
 * pre-pass for the guard only — the original SQL is what actually executes.
 */
export function stripStringsAndComments(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'" || c === '"') {
      const quote = c;
      i += 1;
      while (i < sql.length) {
        if (sql[i] === quote) {
          // A doubled quote is an escaped quote inside the literal, not its end.
          if (sql[i + 1] === quote) {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      out += " ";
      continue;
    }
    if (c === "-" && sql[i + 1] === "-") {
      i += 2;
      while (i < sql.length && sql[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/**
 * Validate that `sql` is a single read-only `SELECT` and return it with any trailing semicolon
 * removed (ready to execute), or throw {@link NonReadOnlyQueryError}.
 *
 * The guard rests on two facts about DuckDB rather than a keyword denylist (which false-positives
 * on string literals and column names): (1) a statement that begins with `SELECT` or `WITH` cannot
 * modify data — DuckDB has no data-modifying CTEs (unlike Postgres's `WITH ... INSERT`), and every
 * write/DDL/attach/copy/pragma statement begins with its own keyword, never `SELECT`/`WITH`; and
 * (2) allowing exactly one statement stops `SELECT 1; DROP TABLE x`. Literals and comments are
 * stripped first so a `;` or a leading comment inside them cannot fool either check.
 */
export function assertReadOnlySelect(sql: string): string {
  const trimmed = sql.trim();
  if (trimmed.length === 0) {
    throw new NonReadOnlyQueryError("query is empty");
  }
  // Drop a single optional trailing semicolon — a normal way to end one statement.
  const withoutTrailing = trimmed.replace(/;\s*$/, "");
  const sanitized = stripStringsAndComments(withoutTrailing);
  if (sanitized.includes(";")) {
    throw new NonReadOnlyQueryError("only a single SELECT statement is allowed");
  }
  const head = sanitized.replace(/^\s+/, "");
  if (!/^(select|with)\b/i.test(head)) {
    throw new NonReadOnlyQueryError("only read-only SELECT queries are allowed");
  }
  return withoutTrailing;
}

/** One column of a query result: its name and DuckDB-reported type. */
export const QueryColumnSchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
});
export type QueryColumn = z.infer<typeof QueryColumnSchema>;

/**
 * The result of a `run_query` call (PRD FR7): the ordered columns with their types, the returned
 * rows (each a name→JSON-safe cell map), the number of rows returned, and whether the underlying
 * result had more rows than {@link MAX_QUERY_ROWS} (so the UI can say "showing the first N").
 */
export const QueryResultSchema = z.object({
  columns: z.array(QueryColumnSchema),
  rows: z.array(z.record(z.string(), ServedCellSchema)),
  rowCount: z.number().int().nonnegative(),
  truncated: z.boolean(),
});
export type QueryResult = z.infer<typeof QueryResultSchema>;

/**
 * Assemble a validated {@link QueryResult} from DuckDB's `DESCRIBE` columns and raw result rows.
 * Rows are built column-by-column off the described columns (so the shape is authoritative even
 * for a 0-row result), each cell coerced through {@link toJsonCell}, and capped at
 * {@link MAX_QUERY_ROWS} with `truncated` set when the raw result held more. Pure: the I/O layer
 * gathers `described`/`raw`; this classifies and validates.
 */
export function buildQueryResult(
  described: { name: string; type: string }[],
  raw: Record<string, unknown>[],
): QueryResult {
  const columns = described.map((c) => ({ name: c.name, type: c.type }));
  const capped = raw.slice(0, MAX_QUERY_ROWS);
  const rows = capped.map((row) => {
    const cells: Record<string, unknown> = {};
    for (const col of columns) cells[col.name] = toJsonCell(row[col.name]);
    return cells;
  });
  return QueryResultSchema.parse({
    columns,
    rows,
    rowCount: rows.length,
    truncated: raw.length > MAX_QUERY_ROWS,
  });
}
