import { z } from "zod";
import { APPROVAL_ACTIONS } from "./approvals.js";
import { RunSchema, RunStepSchema } from "./run.js";

/**
 * Pure run-lineage contract (PRD FR12, TASKS T5.5). FR12 requires each run to record its
 * **steps, tool calls, approvals, and DQ results**, viewable per run. Three of those four are the
 * observability record of an execution that already happened; the shapes live here so the store
 * ({@link file://../store/lineage.ts}), the runner ({@link file://../pipeline/runner.ts}), and the
 * `GET /api/runs/:runId/lineage` route all agree without any of them importing each other. No
 * fs/net/process — see ARCHITECTURE §3.2's core/ purity rule.
 *
 * Steps are already modelled by {@link file://./run.ts} ({@link RunStepSchema}); this module adds
 * the other three records and the aggregate {@link RunLineageSchema} the run detail view reads.
 */

/**
 * A recorded tool call's lifecycle. `running` is written before the tool executes so a call that
 * never returns (a crash mid-execution) still leaves a trace rather than vanishing — the honest
 * record of "we started this" is what makes the lineage trustworthy. `success`/`failed` are
 * terminal.
 */
export const TOOL_CALL_STATUSES = ["running", "success", "failed"] as const;
export type ToolCallStatus = (typeof TOOL_CALL_STATUSES)[number];

/**
 * Parse a persisted JSON args column back into a record.
 *
 * Returns `null` when nothing usable was recorded — the column was NULL, the text does not parse,
 * or it parses to a non-object (a bare string/array/number is not an args map). Never throws and
 * never invents an empty `{}` for unreadable content: a lineage view must be able to say "the args
 * were not recorded" rather than imply the tool ran with none. Writers always persist
 * `JSON.stringify(record)`, so in practice `null` means a NULL column or a corrupted row.
 */
export function parseArgsJson(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

/**
 * One recorded invocation of a pipeline tool (FR12 "tool calls"). The runner writes one of these
 * per `ask`/read-only tool it executes — `land_parquet`, `load_warehouse`, `run_transform`,
 * `run_dq_check`, `publish_serving` — capturing what ran, with which args, and what came back.
 * A stage without a tool (Extract) records none, so this is a strict record of tool execution
 * rather than a duplicate of the step list.
 */
export const RunToolCallSchema = z.object({
  /** Application-generated id for this record. */
  id: z.string().min(1),
  /** The run the call belongs to. */
  runId: z.string().min(1),
  /** The run step the call executed under, tying a tool call to its visible stage. */
  stepId: z.string().min(1),
  /** The tool's machine name, e.g. `run_transform`. */
  tool: z.string().min(1),
  /** The args the tool was called with, or `null` when they were not recorded. */
  args: z.record(z.string(), z.unknown()).nullable(),
  /** Lifecycle status; `running` until the call returns or throws. */
  status: z.enum(TOOL_CALL_STATUSES),
  /** Human-readable outcome on success (e.g. "landed 3 rows"), else `null`. */
  result: z.string().nullable(),
  /** The error message when the call failed, else `null`. */
  error: z.string().nullable(),
  /** When the call started. */
  startedAt: z.string(),
  /** When it finished; `null` while still running. */
  finishedAt: z.string().nullable(),
});
export type RunToolCall = z.infer<typeof RunToolCallSchema>;

/**
 * One recorded approval decision (FR8/FR12 "approvals"). Written when a human answers a gated
 * stage, so the trail proves every executed write tool was approved first — the evidence behind
 * PRD §5's "100% of executions required a human approval".
 */
export const RunApprovalRecordSchema = z.object({
  /** Application-generated id for this audit row. */
  id: z.string().min(1),
  /** The run the decision belongs to. */
  runId: z.string().min(1),
  /** The approval request that was answered. */
  requestId: z.string().min(1),
  /** The `ask` tool that was gated. */
  tool: z.string().min(1),
  /** The args the human saw and approved, or `null` when not recorded. */
  args: z.record(z.string(), z.unknown()).nullable(),
  /** The decision a human made. */
  action: z.enum(APPROVAL_ACTIONS),
  /** When the audit row was written. */
  createdAt: z.string(),
  /** When the human decided; `null` only for a row written before a decision. */
  decidedAt: z.string().nullable(),
});
export type RunApprovalRecord = z.infer<typeof RunApprovalRecordSchema>;

/**
 * One recorded data-quality check outcome (FR7/FR12 "DQ results"). Written for **every** check the
 * DQ stage ran, passing or failing, before a failure aborts the run — the record of *why* publish
 * was blocked is precisely what makes the block auditable.
 */
export const RunDqResultSchema = z.object({
  /** Application-generated id for this record. */
  id: z.string().min(1),
  /** The run the check ran under. */
  runId: z.string().min(1),
  /** The check's name, echoed from the reviewed DQ spec. */
  checkName: z.string().min(1),
  /** Whether the check passed. A single `false` here is what blocked publish. */
  passed: z.boolean(),
  /** Human-readable outcome (counts, or the error when the check's query threw). */
  detail: z.string().nullable(),
  /** When the result was recorded. */
  createdAt: z.string(),
});
export type RunDqResult = z.infer<typeof RunDqResultSchema>;

/**
 * The complete per-run lineage record (FR12): the run, its ordered steps, every tool call, every
 * approval decision, and every DQ result. This is what `GET /api/runs/:runId/lineage` returns and
 * the run detail view renders. Each list is independently empty-able — a run rejected at its first
 * gate has steps and one approval but no successful tool calls and no DQ results.
 */
export const RunLineageSchema = z.object({
  /** The run itself. */
  run: RunSchema,
  /** Its stages, in pipeline order. */
  steps: z.array(RunStepSchema),
  /** Every tool the run executed, oldest first. */
  toolCalls: z.array(RunToolCallSchema),
  /** Every approval decision a human made, oldest first. */
  approvals: z.array(RunApprovalRecordSchema),
  /** Every DQ check outcome, in the order they were recorded. */
  dqResults: z.array(RunDqResultSchema),
});
export type RunLineage = z.infer<typeof RunLineageSchema>;
