import { z } from "zod";

/**
 * Pure lineage/audit contract for the v2 conversational agent (PRD FR12, TASKS V4.4). Unlike the
 * v1 deterministic runner — which split its audit across `run_tool_calls` / `approvals` /
 * `dq_results` keyed by a run id ({@link file://./lineage.ts}) — the agent path has no runner
 * assigning run ids: the user drives the work by conversation, so the audit is a single
 * append-only log per **chat session**. Each row is one auditable event the agent produced:
 *
 * - `tool_call` — an approval-gated write tool executed (or was rejected / errored). The audit
 *   trail PRD §5 requires ("100% of write tools required an inline approval before executing,
 *   verified from the lineage/audit trail") reads these against the `approval` rows: a write's
 *   `tool_call` is only ever recorded *after* its approval was answered, so the log shows the
 *   approval preceding the execution.
 * - `approval` — a human's decision (approve/reject) on a paused write, from the approvals route.
 * - `dq_result` — a `run_dq_check` outcome (pass/fail), so the check that blocked a publish (FR9)
 *   is explained in the trail.
 *
 * Read tools (`list_sources`/`profile_source`/`run_query`) are non-mutating and deliberately not
 * logged here — the lineage is the write/approval/quality audit, not a full keystroke log. This
 * module stays pure (no fs/net/process): the store ({@link file://../store/session-lineage.ts})
 * and route reuse these shapes, and the web view mirrors them.
 */

/** The kinds of auditable event the session lineage log records, discriminated by `kind`. */
export const LINEAGE_KINDS = ["tool_call", "approval", "dq_result"] as const;
export type LineageKind = (typeof LINEAGE_KINDS)[number];

/**
 * The terminal status a lineage row can carry, across all kinds:
 * - a `tool_call` is `completed` (the write ran), `rejected` (the human denied it), or `error`
 *   (approved but the write failed);
 * - an `approval` decision is `approved` or `rejected`;
 * - a `dq_result` is `passed` or `failed`.
 * Kept as one closed set so a persisted status is always one the UI knows how to render.
 */
export const LINEAGE_STATUSES = [
  "completed",
  "error",
  "rejected",
  "approved",
  "passed",
  "failed",
] as const;
export type LineageStatus = (typeof LINEAGE_STATUSES)[number];

/**
 * One row of a session's lineage/audit log. `seq` orders events within a session monotonically
 * (wall-clock `createdAt` can tie at sub-ms resolution, so `seq` is the ordering key the reads and
 * the view use). `runId` groups the events of one build the agent orchestrated; it is `null` in the
 * MVP agent path (there is no runner assigning run ids), the seam left for a future grouping.
 * `tool` names the tool for `tool_call`/`approval` rows (`null` otherwise); `status` is the
 * terminal outcome; `detail` carries the kind-specific JSON payload (args + result, the reviewed
 * metadata, or the DQ check outcomes) as a parsed object, or `null` when there is none.
 */
export const LineageEventSchema = z.object({
  /** Application-generated id for the row. */
  id: z.string().min(1),
  /** The chat session this event belongs to. */
  sessionId: z.string().min(1),
  /** The build grouping id, or `null` for an ad-hoc event (the MVP agent path is always null). */
  runId: z.string().min(1).nullable(),
  /** Monotonic per-session order of the event. */
  seq: z.number().int().nonnegative(),
  /** Which kind of auditable event this is. */
  kind: z.enum(LINEAGE_KINDS),
  /** The tool the event concerns (`tool_call`/`approval`), or `null`. */
  tool: z.string().min(1).nullable(),
  /** The terminal status of the event, or `null` when a kind carries none. */
  status: z.enum(LINEAGE_STATUSES).nullable(),
  /** The kind-specific JSON payload as a parsed object, or `null`. */
  detail: z.record(z.string(), z.unknown()).nullable(),
  /** When the row was written (ISO-ish string; DuckDB `now()` cast to VARCHAR on read). */
  createdAt: z.string().min(1),
});
export type LineageEvent = z.infer<typeof LineageEventSchema>;

/** The `GET /api/sessions/:id/lineage` response body — a session's lineage in `seq` order. */
export const SessionLineageResponseSchema = z.object({
  lineage: z.array(LineageEventSchema),
});
export type SessionLineageResponse = z.infer<typeof SessionLineageResponseSchema>;

/**
 * Parse a stored `detail` JSON string back into an object, or `null`. The store writes `detail`
 * as `JSON.stringify(object)` (or SQL NULL when there is none), so on read we `JSON.parse` it and
 * keep it only when it is a plain object — a non-object or unparseable payload becomes `null`
 * rather than crashing the read, so one malformed row cannot break the whole audit view.
 */
export function parseLineageDetail(raw: string | null): Record<string, unknown> | null {
  if (raw === null || raw === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}
