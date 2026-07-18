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
