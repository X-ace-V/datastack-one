import type { WarehouseStore } from "./duckdb.js";
import {
  RunApprovalRecordSchema,
  RunDqResultSchema,
  RunToolCallSchema,
  parseArgsJson,
  type RunApprovalRecord,
  type RunDqResult,
  type RunLineage,
  type RunToolCall,
  type ToolCallStatus,
} from "../core/lineage.js";
import type { DqCheckResult } from "../core/dq.js";
import { getRunState } from "./runs.js";

/**
 * Persistence for a run's lineage (PRD FR12, TASKS T5.5): the tool calls it executed, the DQ
 * results it produced, and the reads that assemble those — with the run's steps and approvals —
 * into the {@link RunLineage} the run detail view renders. An I/O module (it wraps a
 * {@link WarehouseStore}), so it lives under `server/store`; the shapes are the pure
 * {@link file://../core/lineage.ts}. Every write binds input through positional parameters; no
 * field is ever concatenated into SQL. Timestamps are cast to VARCHAR on read so they arrive as
 * plain strings rather than `DuckDBTimestampValue` objects.
 *
 * Ordering note: rows are ordered by their timestamp with `id` as a stable tiebreak. DuckDB stamps
 * `now()` per auto-commit statement, so sequential writes order correctly; the `id` tiebreak only
 * makes reads *stable* when two rows share a timestamp — it is not a promise that ties resolve into
 * the order the tools or checks were declared in.
 */

const TOOL_CALL_COLUMNS =
  "id, run_id, step_id, tool, args, status, result, error, " +
  "CAST(started_at AS VARCHAR) AS started_at, " +
  "CAST(finished_at AS VARCHAR) AS finished_at";

const APPROVAL_COLUMNS =
  "id, run_id, request_id, tool, args, action, " +
  "CAST(created_at AS VARCHAR) AS created_at, " +
  "CAST(decided_at AS VARCHAR) AS decided_at";

const DQ_RESULT_COLUMNS =
  "id, run_id, check_name, passed, detail, CAST(created_at AS VARCHAR) AS created_at";

/** Map a raw `platform.run_tool_calls` row to a validated {@link RunToolCall}. */
function rowToToolCall(row: Record<string, unknown>): RunToolCall {
  return RunToolCallSchema.parse({
    id: row.id,
    runId: row.run_id,
    stepId: row.step_id,
    tool: row.tool,
    args: parseArgsJson((row.args as string | null) ?? null),
    status: row.status,
    result: row.result ?? null,
    error: row.error ?? null,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? null,
  });
}

/** Map a raw `platform.approvals` row to a validated {@link RunApprovalRecord}. */
function rowToApproval(row: Record<string, unknown>): RunApprovalRecord {
  return RunApprovalRecordSchema.parse({
    id: row.id,
    runId: row.run_id,
    requestId: row.request_id,
    tool: row.tool,
    args: parseArgsJson((row.args as string | null) ?? null),
    action: row.action,
    createdAt: row.created_at,
    decidedAt: row.decided_at ?? null,
  });
}

/** Map a raw `platform.dq_results` row to a validated {@link RunDqResult}. */
function rowToDqResult(row: Record<string, unknown>): RunDqResult {
  return RunDqResultSchema.parse({
    id: row.id,
    runId: row.run_id,
    checkName: row.check_name,
    // DuckDB returns BOOLEAN as a JS boolean; coerce defensively for the schema's strict check.
    passed: Boolean(row.passed),
    detail: row.detail ?? null,
    createdAt: row.created_at,
  });
}

/** Fields needed to open a tool-call record, written before the tool executes. */
export interface StartToolCallInput {
  /** Application-generated id for the record. */
  id: string;
  /** The run the call belongs to. */
  runId: string;
  /** The run step the call executes under. */
  stepId: string;
  /** The tool's machine name. */
  tool: string;
  /** The args the tool is called with; serialized as JSON for the record. */
  args: Record<string, unknown>;
}

/**
 * Open a tool-call record with status `running` and return it as persisted. Called **before** the
 * tool executes so the record exists even if the call never returns — the lineage should show a
 * call that started and died, not silently omit it.
 */
export async function startToolCall(
  store: WarehouseStore,
  input: StartToolCallInput,
): Promise<RunToolCall> {
  await store.run(
    `INSERT INTO platform.run_tool_calls (id, run_id, step_id, tool, args)
     VALUES ($1, $2, $3, $4, $5)`,
    [input.id, input.runId, input.stepId, input.tool, JSON.stringify(input.args)],
  );
  const rows = await store.all(
    `SELECT ${TOOL_CALL_COLUMNS} FROM platform.run_tool_calls WHERE id = $1`,
    [input.id],
  );
  const row = rows[0];
  if (!row) throw new Error(`tool call ${input.id} was not found immediately after insert`);
  return rowToToolCall(row);
}

/**
 * Close a tool-call record with its terminal status, stamping the finish time. `result` carries the
 * human-readable outcome on success and `error` the message on failure; passing the irrelevant one
 * as `null` keeps the row unambiguous about which way the call went.
 */
export async function completeToolCall(
  store: WarehouseStore,
  id: string,
  status: Exclude<ToolCallStatus, "running">,
  outcome: { result?: string | null; error?: string | null },
): Promise<void> {
  await store.run(
    `UPDATE platform.run_tool_calls
        SET status = $1, result = $2, error = $3, finished_at = now()
      WHERE id = $4`,
    [status, outcome.result ?? null, outcome.error ?? null, id],
  );
}

/**
 * Record every executed DQ check outcome for a run (FR7/FR12). Written for passing **and** failing
 * checks, and written before a failure aborts the run, so the lineage explains exactly which check
 * blocked publish. Each result is inserted as its own statement so DuckDB stamps `created_at` per
 * row rather than once for the batch.
 */
export async function recordDqResults(
  store: WarehouseStore,
  runId: string,
  results: readonly (DqCheckResult & { id: string })[],
): Promise<void> {
  for (const result of results) {
    await store.run(
      `INSERT INTO platform.dq_results (id, run_id, check_name, passed, detail)
       VALUES ($1, $2, $3, $4, $5)`,
      [result.id, runId, result.name, result.passed, result.detail],
    );
  }
}

/** List a run's tool calls, oldest first. */
export async function listRunToolCalls(
  store: WarehouseStore,
  runId: string,
): Promise<RunToolCall[]> {
  const rows = await store.all(
    `SELECT ${TOOL_CALL_COLUMNS} FROM platform.run_tool_calls
      WHERE run_id = $1 ORDER BY started_at, id`,
    [runId],
  );
  return rows.map(rowToToolCall);
}

/** List a run's recorded approval decisions, oldest first (FR8's audit trail). */
export async function listRunApprovals(
  store: WarehouseStore,
  runId: string,
): Promise<RunApprovalRecord[]> {
  const rows = await store.all(
    `SELECT ${APPROVAL_COLUMNS} FROM platform.approvals
      WHERE run_id = $1 ORDER BY created_at, id`,
    [runId],
  );
  return rows.map(rowToApproval);
}

/** List a run's recorded DQ check outcomes, in the order they were recorded. */
export async function listRunDqResults(
  store: WarehouseStore,
  runId: string,
): Promise<RunDqResult[]> {
  const rows = await store.all(
    `SELECT ${DQ_RESULT_COLUMNS} FROM platform.dq_results
      WHERE run_id = $1 ORDER BY created_at, id`,
    [runId],
  );
  return rows.map(rowToDqResult);
}

/**
 * Assemble a run's complete lineage (FR12) — run + steps + tool calls + approvals + DQ results — or
 * `null` when the run is unknown. The four record lists are read independently, so a run that never
 * reached a stage simply carries an empty list for it rather than failing the read.
 */
export async function getRunLineage(
  store: WarehouseStore,
  runId: string,
): Promise<RunLineage | null> {
  const state = await getRunState(store, runId);
  if (!state) return null;
  const [toolCalls, approvals, dqResults] = await Promise.all([
    listRunToolCalls(store, runId),
    listRunApprovals(store, runId),
    listRunDqResults(store, runId),
  ]);
  return { run: state.run, steps: state.steps, toolCalls, approvals, dqResults };
}
