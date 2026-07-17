import { z } from "zod";
import { APPROVAL_ACTIONS } from "./approvals.js";

/**
 * Pure pipeline-run contract (PRD FR8/FR9/FR12, ARCHITECTURE §4). Holds the ordered pipeline
 * stages, the run/step status vocabularies, and the schemas for a run's persisted state, the
 * per-stage progress the UI streams over SSE, and the approval request a human answers before a
 * gated stage runs. No fs/net/process — the runner ({@link file://../pipeline/runner.ts}), the
 * store ({@link file://../store/runs.ts}), and the routes all build on these shapes, so the wire
 * contract can be unit-tested directly. See ARCHITECTURE §3.4, §6.
 */

/**
 * A run's lifecycle status. `pending` before it starts, `running` while stages execute,
 * `success` when every stage passed, `failed` when a stage errored, `rejected` when a human
 * denied a gated stage's approval (distinct from a technical failure).
 */
export const RUN_STATUSES = [
  "pending",
  "running",
  "success",
  "failed",
  "rejected",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/**
 * A single stage's status. `skipped` is reserved for a stage the runner declined to execute
 * (e.g. a later stage after an earlier one failed); the currently-wired stages only move
 * pending → running → success/failed.
 */
export const STEP_STATUSES = [
  "pending",
  "running",
  "success",
  "failed",
  "skipped",
] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

/** One ordered stage of the scripted pipeline (ARCHITECTURE §4). */
export interface PipelineStageDef {
  /** Machine name, also the persisted `run_steps.name`. */
  name: string;
  /** Human label for the progress stepper. */
  label: string;
  /** The write/execute tool this stage runs, or `null` for a read-only stage. */
  tool: string | null;
  /** Whether the stage pauses for human approval before executing (FR8). */
  gated: boolean;
}

/**
 * The ordered pipeline stages the runner executes: Extract → Land → Load → Transform → DQ →
 * Publish — the six visible tasks of ARCHITECTURE §4 (PRD §5: "≥5 visible pipeline tasks").
 * `gated` stages are the `ask` tools that pause for approval (their names match
 * {@link file://../opencode/config.ts}'s `ASK_TOOLS`); the DQ stage runs read-only checks and is
 * NOT gated, but a DQ failure aborts the run so the Publish stage never runs (FR7). Note `gated`
 * is therefore narrower than "names a tool" — assert the gated set explicitly rather than
 * deriving it from `tool !== null`.
 */
export const PIPELINE_STAGES: readonly PipelineStageDef[] = [
  { name: "extract", label: "Extract", tool: null, gated: false },
  { name: "land", label: "Land Parquet", tool: "land_parquet", gated: true },
  { name: "load", label: "Load Warehouse", tool: "load_warehouse", gated: true },
  { name: "transform", label: "Transform", tool: "run_transform", gated: true },
  { name: "dq", label: "DQ Checks", tool: "run_dq_check", gated: false },
  { name: "publish", label: "Publish", tool: "publish_serving", gated: true },
] as const;

/** Request body for `POST /api/projects/:id/run`: which source + optional per-run model. */
export const RunStartRequestSchema = z.object({
  /** Source to run; defaults to the project's newest upload when omitted. */
  sourceId: z.string().min(1).optional(),
  /** Optional `provider/model` override for the run's generation stages. */
  model: z.string().min(1).optional(),
});
export type RunStartRequest = z.infer<typeof RunStartRequestSchema>;

/** A persisted pipeline run. */
export const RunSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  status: z.enum(RUN_STATUSES),
  model: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Run = z.infer<typeof RunSchema>;

/** A persisted per-stage step of a run. */
export const RunStepSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  name: z.string().min(1),
  ordinal: z.number().int().nonnegative(),
  status: z.enum(STEP_STATUSES),
  detail: z.string().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});
export type RunStep = z.infer<typeof RunStepSchema>;

/** A run plus its ordered steps — the shape the run routes and SSE consumers read. */
export const RunStateSchema = z.object({
  run: RunSchema,
  steps: z.array(RunStepSchema),
});
export type RunState = z.infer<typeof RunStateSchema>;

/**
 * A gated stage's pending approval request. Carries what the UI shows a human before they
 * approve execution (FR8): the exact SQL/DDL when the stage runs a known statement (the
 * transform), a human-readable summary otherwise, and the tool args. The `requestID` is what
 * `POST /api/runs/:runId/approvals/:requestID` answers.
 */
export const RunApprovalRequestSchema = z.object({
  /** Approval id — the `:requestID` path param used to answer it. */
  requestID: z.string().min(1),
  /** The run this approval belongs to. */
  runId: z.string().min(1),
  /** The run step this approval gates. */
  stepId: z.string().min(1),
  /** The gated stage's machine name (e.g. `land`, `load`, `transform`). */
  stepName: z.string().min(1),
  /** The `ask` tool that will run once approved. */
  tool: z.string().min(1),
  /** Human-readable description of what will run. */
  summary: z.string(),
  /** The exact SQL/DDL to be executed when known (the transform), else `null`. */
  sql: z.string().nullable(),
  /** The tool arguments, for the UI to render the full request. */
  args: z.record(z.string(), z.unknown()),
});
export type RunApprovalRequest = z.infer<typeof RunApprovalRequestSchema>;

/**
 * A run-progress event streamed to the UI over SSE (FR9). A discriminated union on `kind`:
 * run-level status transitions, per-step status transitions, and the approval request/resolution
 * pair that surfaces the FR8 gate. The runner emits these; the bridge frames each onto the wire.
 */
export const RunEventSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("run.status"),
    runId: z.string().min(1),
    status: z.enum(RUN_STATUSES),
  }),
  z.object({
    kind: z.literal("step.status"),
    runId: z.string().min(1),
    stepId: z.string().min(1),
    name: z.string().min(1),
    status: z.enum(STEP_STATUSES),
    detail: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("approval.requested"),
    runId: z.string().min(1),
    request: RunApprovalRequestSchema,
  }),
  z.object({
    kind: z.literal("approval.resolved"),
    runId: z.string().min(1),
    requestID: z.string().min(1),
    action: z.enum(APPROVAL_ACTIONS),
  }),
]);
export type RunEvent = z.infer<typeof RunEventSchema>;
