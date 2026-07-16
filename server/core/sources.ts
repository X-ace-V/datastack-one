import { z } from "zod";

/**
 * Pure source contract (PRD FR2). A source is a CSV a user uploads into a project; the
 * upload lands the raw file under `data/uploads/` and records a row in the DuckDB
 * `platform.sources` table by {@link file://../store/sources.ts}, exposed over
 * `POST/GET /api/projects/:id/source(s)`. Profiling (row counts, schema) is a later step
 * (T2.3), so `rowCount` is nullable here.
 *
 * This module stays pure — no fs/net/process — so the upload validation and row shape can
 * be reused by the route, the store, and the UI, and unit-tested in isolation.
 */

/**
 * Source kinds a project may hold. The MVP is CSV-only (PRD §2); the set exists so the API
 * rejects anything else now and so future connectors slot in behind one interface later.
 */
export const SOURCE_KINDS = ["csv"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/** File extension a CSV upload must carry. */
export const CSV_EXTENSION = ".csv";

/**
 * Decide whether an uploaded file is an acceptable CSV. Browsers report inconsistent MIME
 * types for CSV (`text/csv`, `application/vnd.ms-excel`, `application/octet-stream`, …), so
 * the reliable signal is the `.csv` filename extension — that is what we gate on.
 */
export function isCsvFilename(filename: string): boolean {
  return filename.trim().toLowerCase().endsWith(CSV_EXTENSION);
}

/**
 * Reduce a client-supplied filename to a safe on-disk basename: drop any directory
 * components (defeating `../` path traversal) and replace anything outside
 * `[A-Za-z0-9._-]` with `_`. Never returns an empty string.
 */
export function safeUploadFilename(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, "_");
  return cleaned.length > 0 ? cleaned : "upload.csv";
}

/**
 * A persisted source as returned by the API. `originalFilename` is nullable (a stream can
 * arrive unnamed) and `rowCount` is nullable until the profile step counts it. Field names
 * are camelCase; the store maps the snake_case columns.
 */
export const SourceSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  kind: z.string().min(1),
  path: z.string().min(1),
  originalFilename: z.string().nullable(),
  rowCount: z.number().int().nonnegative().nullable(),
  createdAt: z.string().min(1),
});
export type Source = z.infer<typeof SourceSchema>;

/** Response body for `GET /api/projects/:id/sources` — the project's sources, newest first. */
export const SourceListResponseSchema = z.object({
  sources: z.array(SourceSchema),
});
export type SourceListResponse = z.infer<typeof SourceListResponseSchema>;
