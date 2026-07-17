import type { WarehouseStore } from "./duckdb.js";
import {
  RunSchema,
  RunStepSchema,
  type Run,
  type RunState,
  type RunStatus,
  type RunStep,
  type StepStatus,
} from "../core/run.js";
import type { ApprovalAction } from "../core/approvals.js";

/**
 * Persistence for pipeline runs (PRD FR9/FR12) in the DuckDB `platform.runs`, `platform.run_steps`,
 * and `platform.approvals` tables. An I/O module by design — it wraps a {@link WarehouseStore} —
 * so it lives under `server/store`, not `server/core`. Every write binds input through parameters
 * ($1, $2, …); no field is ever concatenated into SQL. Timestamps are cast to VARCHAR on read so
 * they arrive as plain strings (`getRowObjects` otherwise returns `DuckDBTimestampValue`). See
 * ARCHITECTURE §3.4.
 */

const RUN_COLUMNS =
  "id, project_id, status, model, " +
  "CAST(created_at AS VARCHAR) AS created_at, " +
  "CAST(updated_at AS VARCHAR) AS updated_at";

const STEP_COLUMNS =
  "id, run_id, name, ordinal, status, detail, " +
  "CAST(started_at AS VARCHAR) AS started_at, " +
  "CAST(finished_at AS VARCHAR) AS finished_at";

/** Map a raw `platform.runs` row (snake_case, nullable) to a validated {@link Run}. */
function rowToRun(row: Record<string, unknown>): Run {
  return RunSchema.parse({
    id: row.id,
    projectId: row.project_id,
    status: row.status,
    model: row.model ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

/** Map a raw `platform.run_steps` row (snake_case, nullable, integer ordinal) to a {@link RunStep}. */
function rowToStep(row: Record<string, unknown>): RunStep {
  return RunStepSchema.parse({
    id: row.id,
    runId: row.run_id,
    name: row.name,
    // DuckDB returns INTEGER as number, but coerce defensively for the schema's int check.
    ordinal: Number(row.ordinal),
    status: row.status,
    detail: row.detail ?? null,
    startedAt: row.started_at ?? null,
    finishedAt: row.finished_at ?? null,
  });
}

/** Fields needed to create a run row. `model` is the per-run model override, if any. */
export interface CreateRunInput {
  /** Application-generated run id. */
  id: string;
  /** Owning project. */
  projectId: string;
  /** Per-run model, or `null`/absent for the runtime default. */
  model?: string | null;
}

/**
 * Insert a run and return it as persisted. The id is caller-generated; `status`, `created_at`,
 * and `updated_at` come from the table defaults, so the row is read back after the insert.
 */
export async function createRun(
  store: WarehouseStore,
  input: CreateRunInput,
): Promise<Run> {
  await store.run(
    `INSERT INTO platform.runs (id, project_id, model) VALUES ($1, $2, $3)`,
    [input.id, input.projectId, input.model ?? null],
  );
  const run = await getRun(store, input.id);
  if (!run) throw new Error(`run ${input.id} was not found immediately after insert`);
  return run;
}

/** Fields needed to create one pending run step. */
export interface InsertRunStepInput {
  /** Application-generated step id. */
  id: string;
  /** Owning run. */
  runId: string;
  /** Stage machine name. */
  name: string;
  /** Position in the pipeline (0-based). */
  ordinal: number;
}

/**
 * Insert a pending run step and return it as persisted. `status` defaults to `pending` and the
 * timestamps stay null until the runner starts/finishes the step.
 */
export async function insertRunStep(
  store: WarehouseStore,
  input: InsertRunStepInput,
): Promise<RunStep> {
  await store.run(
    `INSERT INTO platform.run_steps (id, run_id, name, ordinal) VALUES ($1, $2, $3, $4)`,
    [input.id, input.runId, input.name, input.ordinal],
  );
  const rows = await store.all(
    `SELECT ${STEP_COLUMNS} FROM platform.run_steps WHERE id = $1`,
    [input.id],
  );
  const row = rows[0];
  if (!row) throw new Error(`run step ${input.id} was not found immediately after insert`);
  return rowToStep(row);
}

/** Fetch a run by id, or `null` if none exists. */
export async function getRun(
  store: WarehouseStore,
  runId: string,
): Promise<Run | null> {
  const rows = await store.all(
    `SELECT ${RUN_COLUMNS} FROM platform.runs WHERE id = $1`,
    [runId],
  );
  const row = rows[0];
  return row ? rowToRun(row) : null;
}

/**
 * List a project's runs, newest first — the run history a client pages through to open one run's
 * lineage (FR12). Ordered by `created_at` with `id` as a stable tiebreak so two runs created within
 * the same timestamp still read back in a fixed order.
 */
export async function listRuns(
  store: WarehouseStore,
  projectId: string,
): Promise<Run[]> {
  const rows = await store.all(
    `SELECT ${RUN_COLUMNS} FROM platform.runs WHERE project_id = $1 ORDER BY created_at DESC, id`,
    [projectId],
  );
  return rows.map(rowToRun);
}

/** List a run's steps in pipeline order. */
export async function listRunSteps(
  store: WarehouseStore,
  runId: string,
): Promise<RunStep[]> {
  const rows = await store.all(
    `SELECT ${STEP_COLUMNS} FROM platform.run_steps WHERE run_id = $1 ORDER BY ordinal`,
    [runId],
  );
  return rows.map(rowToStep);
}

/** Fetch a run plus its ordered steps, or `null` if the run is unknown. */
export async function getRunState(
  store: WarehouseStore,
  runId: string,
): Promise<RunState | null> {
  const run = await getRun(store, runId);
  if (!run) return null;
  const steps = await listRunSteps(store, runId);
  return { run, steps };
}

/** Set a run's status and bump `updated_at`. */
export async function updateRunStatus(
  store: WarehouseStore,
  runId: string,
  status: RunStatus,
): Promise<void> {
  await store.run(
    `UPDATE platform.runs SET status = $1, updated_at = now() WHERE id = $2`,
    [status, runId],
  );
}

/** Mark a step running and stamp its start time. */
export async function startRunStep(
  store: WarehouseStore,
  stepId: string,
): Promise<void> {
  await store.run(
    `UPDATE platform.run_steps SET status = 'running', started_at = now() WHERE id = $1`,
    [stepId],
  );
}

/** Mark a step finished with a terminal status + human-readable detail, stamping finish time. */
export async function completeRunStep(
  store: WarehouseStore,
  stepId: string,
  status: StepStatus,
  detail: string | null,
): Promise<void> {
  await store.run(
    `UPDATE platform.run_steps SET status = $1, detail = $2, finished_at = now() WHERE id = $3`,
    [status, detail, stepId],
  );
}

/** Fields needed to record a resolved approval to the audit trail (FR8/FR12). */
export interface RecordApprovalInput {
  /** Application-generated audit-row id. */
  id: string;
  /** The run the approval belongs to. */
  runId: string;
  /** The approval request id that was answered. */
  requestId: string;
  /** The `ask` tool that was gated. */
  tool: string;
  /** The tool args, serialized for the audit record. */
  args: string;
  /** The human decision. */
  action: ApprovalAction;
}

/**
 * Record a resolved approval in `platform.approvals` for the run's lineage/audit trail (FR12).
 * `decided_at` is stamped now, since this is written only once a human has answered.
 */
export async function recordApproval(
  store: WarehouseStore,
  input: RecordApprovalInput,
): Promise<void> {
  await store.run(
    `INSERT INTO platform.approvals (id, run_id, request_id, tool, args, action, decided_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())`,
    [input.id, input.runId, input.requestId, input.tool, input.args, input.action],
  );
}
