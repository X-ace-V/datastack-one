import { z } from "zod";

/**
 * Pure contract for the per-session data-source registry (PRD FR4, ARCHITECTURE §3.4).
 * A session source is a CSV (V3.2) or, later, a registered Postgres connection (Phase 5)
 * that a conversational session has connected. The agent references it by `name` only —
 * the raw on-disk `path` (or, later, a database URL) is resolved backend-side and never
 * reaches the model (FR5b). This module stays pure (no fs/net/process) so the shape can be
 * reused by the store, the loopback routes, and the tools, and unit-tested in isolation.
 */

/**
 * A source as persisted in `platform.session_sources`. `path` is the backend-only resolution
 * target — it is present in the store/domain shape but is **stripped** before anything reaches
 * the model (see {@link toListedSource}). `rowCount` is null until the source is profiled.
 */
export const SessionSourceSchema = z.object({
  sessionId: z.string().min(1),
  name: z.string().min(1),
  kind: z.string().min(1),
  path: z.string().min(1),
  rowCount: z.number().int().nonnegative().nullable(),
  createdAt: z.string().min(1),
});
export type SessionSource = z.infer<typeof SessionSourceSchema>;

/**
 * The safe, model-facing view of a source: `name` + `kind` + `rowCount`, with the internal
 * `path` deliberately omitted. This is what `list_sources` returns to the agent — the agent
 * addresses a source by its name, never by its filesystem path or a credentialed URL (FR5b).
 */
export const ListedSourceSchema = z.object({
  name: z.string().min(1),
  kind: z.string().min(1),
  rowCount: z.number().int().nonnegative().nullable(),
});
export type ListedSource = z.infer<typeof ListedSourceSchema>;

/** Project a persisted {@link SessionSource} down to its model-safe {@link ListedSource} view. */
export function toListedSource(source: SessionSource): ListedSource {
  return { name: source.name, kind: source.kind, rowCount: source.rowCount };
}

/**
 * The upload-route view of a session source (V3.2): the persisted fields minus the backend-only
 * `path`. The upload API returns this to the browser — a trusted client, but the path is still
 * withheld so the on-disk location never leaves the backend needlessly. (The model boundary is
 * even tighter — it sees only {@link ListedSource} via `list_sources`.)
 */
export const SessionSourceViewSchema = z.object({
  sessionId: z.string().min(1),
  name: z.string().min(1),
  kind: z.string().min(1),
  rowCount: z.number().int().nonnegative().nullable(),
  createdAt: z.string().min(1),
});
export type SessionSourceView = z.infer<typeof SessionSourceViewSchema>;

/** Project a persisted {@link SessionSource} to its path-free {@link SessionSourceView}. */
export function toSessionSourceView(source: SessionSource): SessionSourceView {
  return {
    sessionId: source.sessionId,
    name: source.name,
    kind: source.kind,
    rowCount: source.rowCount,
    createdAt: source.createdAt,
  };
}

/**
 * The `kind` a registered-Postgres session source carries (V5.3, FR5b). A source is a `csv` (an
 * uploaded file exposed as a DuckDB view) or a `postgres` table exposed through a read-only ATTACH
 * of a registered connection. `run_query` only builds a CSV view for the `csv` kind — a `postgres`
 * source is already queryable by its qualified name through the persistent ATTACH (V5.2).
 */
export const POSTGRES_SOURCE_KIND = "postgres";

/**
 * The name the agent references an attached Postgres table by (V5.3, FR5b): the fully-qualified
 * `<alias>.<schema>.<table>`, where `alias` is the registered connection name. This is exactly the
 * identifier `run_query` resolves against the attached catalog, so registering an attached table
 * under this name makes `list_sources` surface it and `run_query` join it — with no path or
 * credential ever attached to the model-facing view.
 */
export function attachedTableName(
  alias: string,
  schema: string,
  table: string,
): string {
  return `${alias}.${schema}.${table}`;
}

/**
 * Derive a source name from an uploaded filename (V3.2). Drops any directory components and the
 * trailing `.csv`, replaces every run of characters outside `[A-Za-z0-9_]` with a single `_`,
 * and trims leading/trailing underscores. The agent addresses the source by this name and V3.3's
 * `run_query` uses it as a DuckDB identifier, so it must be a clean, injection-free token; when
 * nothing usable survives (e.g. a name of only punctuation) it falls back to `source`.
 */
export function sourceNameFromFilename(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? "";
  const stem = base.replace(/\.csv$/i, "");
  const cleaned = stem.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned.length > 0 ? cleaned : "source";
}
