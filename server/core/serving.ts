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

/** The REST endpoint a served name is queryable at (FR10). */
export function servedEndpoint(name: string): string {
  return `${SERVE_ROUTE_PREFIX}/${name}`;
}

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
