import { z } from "zod";
import { MARTS_SCHEMA } from "./transform.js";
import { safeTableName } from "./warehouse.js";

/**
 * Pure serving contract (PRD FR10, ARCHITECTURE §5). The "Publish" pipeline stage takes the
 * `marts` table the transform materialized and publishes it: it registers the table under a
 * served **name** — the URL segment the generated REST endpoint is reached at — and exports it
 * to CSV for download. This module holds the name sanitizer, the endpoint derivation, the exact
 * `COPY ... (FORMAT CSV, HEADER)` statement the export runs, and the registry row's shape.
 *
 * Stays pure — no fs/net/process — so all of it is unit-testable in isolation and shared by the
 * `publish_serving` tool ({@link file://../tools/serve.ts}, which does the fs/DuckDB work), the
 * pipeline runner (which shows the same SQL at the FR8 approval gate that the tool executes),
 * and the serving routes (T5.3) that resolve `:name` back to a registered table.
 */

/**
 * The export formats `publish_serving` can generate. CSV is the MVP's served artifact (PRD FR10:
 * "downloadable (CSV)"); the closed set is the seam a later format (JSON, Parquet) slots into
 * without changing the tool's interface.
 */
export const SERVING_FORMATS = ["csv"] as const;
export type ServingFormat = (typeof SERVING_FORMATS)[number];

/** The format used when a caller does not name one. */
export const DEFAULT_SERVING_FORMAT: ServingFormat = "csv";

/** Whether a string names one of the supported export formats. */
export function isServingFormat(value: string): value is ServingFormat {
  return (SERVING_FORMATS as readonly string[]).includes(value);
}

/** Fallback served name when a caller-supplied name sanitizes to nothing. */
export const DEFAULT_SERVED_NAME = "report";

/** URL prefix the generated REST endpoints live under (FR10; the routes land in T5.3). */
export const SERVE_ROUTE_PREFIX = "/api/serve";

/**
 * Reduce a caller-supplied served name to one that is safe as **both** a URL segment and a
 * filename: drop any directory components (defeating `../` traversal) and replace anything
 * outside `[A-Za-z0-9_-]` with `_`. Never returns an empty string.
 *
 * Note this is stricter than the landing/artifact sanitizers: `.` is replaced too, because the
 * served name is the `:name` path param of both `/api/serve/:name` and `/api/serve/:name.csv` —
 * a dot in the name would make those two routes ambiguous.
 */
export function safeServedName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[^A-Za-z0-9_-]/g, "_");
  return cleaned.length > 0 ? cleaned : DEFAULT_SERVED_NAME;
}

/**
 * Give a chat-owned publication a globally unique endpoint name. The legacy serving registry is
 * keyed by URL name, so two independent chats publishing `report` must not overwrite each other.
 */
export function sessionScopedServedName(sessionId: string, name: string): string {
  return `${safeServedName(sessionId)}-${safeServedName(name)}`;
}

/** The REST endpoint a served name is queryable at (FR10). */
export function servedEndpoint(name: string): string {
  return `${SERVE_ROUTE_PREFIX}/${name}`;
}

/**
 * Rows a served endpoint returns when the caller does not ask for a page size. A preview-sized
 * default keeps `GET /api/serve/:name` from serializing an arbitrarily large table into one
 * response; a caller that wants everything pages through it with `limit`/`offset`, or downloads
 * the CSV endpoint, which streams the whole export.
 */
export const SERVED_PAGE_DEFAULT_LIMIT = 100;

/** Hard cap on a served page, bounding the work one request can ask the warehouse for. */
export const SERVED_PAGE_MAX_LIMIT = 1000;

/**
 * Query string accepted by `GET /api/serve/:name` (FR10). Values arrive as strings, so both are
 * coerced and then range-checked — a non-numeric, zero, negative or over-cap page is a bad
 * request (400), never a silently clamped one.
 */
export const ServedQuerySchema = z.object({
  /** Maximum rows to return in this page. */
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(SERVED_PAGE_MAX_LIMIT)
    .default(SERVED_PAGE_DEFAULT_LIMIT),
  /** Rows to skip before the page starts. */
  offset: z.coerce.number().int().nonnegative().default(0),
});
export type ServedQuery = z.infer<typeof ServedQuerySchema>;

/** The endpoint a served name downloads as CSV from (FR10). */
export function servedCsvEndpoint(name: string): string {
  return `${SERVE_ROUTE_PREFIX}/${name}.csv`;
}

/** The on-disk filename a served name's CSV export is written as. */
export function servedCsvFilename(name: string): string {
  return `${name}.csv`;
}

/** Escape a string for safe interpolation as a double-quoted SQL identifier. */
function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/** Escape a string for safe interpolation inside a single-quoted SQL literal. */
function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Inputs describing the CSV export statement to build. */
export interface CsvExportSqlInput {
  /** Schema holding the table to export (always {@link MARTS_SCHEMA} in the MVP). */
  schema: string;
  /** Unqualified table name to export. */
  table: string;
  /** Destination file path for the CSV. */
  csvPath: string;
}

/**
 * Build the exact `COPY (SELECT * FROM <schema>.<table>) TO '<csvPath>' (FORMAT CSV, HEADER)`
 * statement the publish stage runs. Both identifiers are sanitized ({@link safeTableName}, which
 * collapses any qualifier or punctuation to a bare identifier) and then double-quoted, and the
 * destination — which DuckDB's `COPY ... TO` cannot accept as a bound parameter — is a
 * single-quote-escaped literal. `HEADER` writes the column names, so the download opens as a
 * usable spreadsheet rather than anonymous rows.
 *
 * This is the single source of truth for that SQL: the runner shows this exact text at the FR8
 * approval gate and the tool executes this exact text, so a human approves what actually runs.
 */
export function buildCsvExportSql(input: CsvExportSqlInput): string {
  const target = `${quoteIdent(safeTableName(input.schema))}.${quoteIdent(safeTableName(input.table))}`;
  return `COPY (SELECT * FROM ${target}) TO ${quoteLiteral(input.csvPath)} (FORMAT CSV, HEADER)`;
}

/**
 * A registered served table (PRD FR10, FR12) as persisted in `platform.served_tables` and
 * returned by the `publish_serving` tool. `name` is the identity — it is the URL segment the
 * table is served at, so the registry holds exactly one row per name and re-publishing a name
 * replaces it (there is no separate id; the endpoint *is* the resource).
 *
 * `endpoint`/`csvEndpoint`/`qualifiedTable` are derived from the stored fields on read rather
 * than persisted, so a route-prefix change can never leave stale URLs in the database.
 */
export const ServedTableSchema = z.object({
  /** Served name — the `:name` segment of the generated endpoints, and the registry key. */
  name: z.string().min(1),
  /** Project that published this table. */
  projectId: z.string().min(1),
  /** Run that published it, or `null` when published outside a run. */
  runId: z.string().min(1).nullable(),
  /** Schema the served table lives in — always `marts` (the transform's output). */
  schema: z.literal(MARTS_SCHEMA),
  /** Sanitized unqualified name of the served `marts` table. */
  table: z.string().min(1),
  /** Fully-qualified `marts.<table>` name the serving routes query. */
  qualifiedTable: z.string().min(1),
  /** Export format generated at publish time. */
  format: z.enum(SERVING_FORMATS),
  /** Rows served, counted from the table at publish time and verified against the export. */
  rowCount: z.number().int().nonnegative(),
  /** On-disk path of the generated CSV export. */
  csvPath: z.string().min(1),
  /** REST endpoint the table is queryable at (FR10). */
  endpoint: z.string().min(1),
  /** Endpoint the table downloads as CSV from (FR10). */
  csvEndpoint: z.string().min(1),
  /** When this name was last published. */
  publishedAt: z.string().min(1),
});
export type ServedTable = z.infer<typeof ServedTableSchema>;

/**
 * One cell of served data, reduced to what JSON can carry losslessly. The warehouse hands back
 * richer runtime values (see {@link toJsonCell}), so every cell passes through that coercion
 * before it reaches a response.
 */
export const ServedCellSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type ServedCell = z.infer<typeof ServedCellSchema>;

/**
 * Coerce one warehouse value into a JSON-safe cell.
 *
 * DuckDB does not return plain JSON values: a `BIGINT` arrives as a `bigint` (which
 * `JSON.stringify` throws on outright), and `DATE`/`TIMESTAMP`/`DECIMAL` arrive as value objects
 * whose `toString()` is the faithful rendering. Both are converted here rather than in a route, so
 * every served response is serializable by construction.
 *
 * A `bigint` outside the IEEE-754 safe-integer range becomes a **string**, not a number: JSON's
 * number type cannot represent it, so converting it would silently return a different value than
 * the warehouse holds. Losing the type is honest; losing the value is not.
 */
export function toJsonCell(value: unknown): ServedCell {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/** A served table's column as reported by the export it is read from. */
export const ServedColumnSchema = z.object({
  /** Column name. */
  name: z.string().min(1),
  /** Column type as DuckDB reports it (e.g. `VARCHAR`, `DOUBLE`, `DATE`). */
  type: z.string().min(1),
});
export type ServedColumn = z.infer<typeof ServedColumnSchema>;

/**
 * The payload `GET /api/serve/:name` returns (FR10: "queryable (REST)") — the served table's
 * identity and endpoints, its columns, the total rows available, and the requested page of them.
 *
 * `rowCount` is the **total** rows served, not `rows.length`: a client reading a page still learns
 * how much there is to page through.
 */
export const ServedDataSchema = z.object({
  /** Served name — the `:name` segment this data was requested at. */
  name: z.string().min(1),
  /** Schema the served table lives in — always `marts`. */
  schema: z.literal(MARTS_SCHEMA),
  /** Unqualified name of the served `marts` table. */
  table: z.string().min(1),
  /** Fully-qualified `marts.<table>` name behind this endpoint. */
  qualifiedTable: z.string().min(1),
  /** Format of the published export this data is read from. */
  format: z.enum(SERVING_FORMATS),
  /** This endpoint's own URL. */
  endpoint: z.string().min(1),
  /** The companion endpoint the same data downloads as CSV from. */
  csvEndpoint: z.string().min(1),
  /** When the served name was last published. */
  publishedAt: z.string().min(1),
  /** Columns of the served table, in export order. */
  columns: z.array(ServedColumnSchema),
  /** Total rows served — independent of how many this page returned. */
  rowCount: z.number().int().nonnegative(),
  /** The requested page of rows. */
  rows: z.array(z.record(z.string(), ServedCellSchema)),
  /** Page size that was applied. */
  limit: z.number().int().positive(),
  /** Rows skipped before this page. */
  offset: z.number().int().nonnegative(),
});
export type ServedData = z.infer<typeof ServedDataSchema>;
