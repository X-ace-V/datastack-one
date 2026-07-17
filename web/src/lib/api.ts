/**
 * Typed client for the DataStack One backend REST API. The Vite dev server proxies
 * `/api/*` to the Fastify backend (see web/vite.config.ts), so these use same-origin
 * relative URLs. Each call throws an `Error` with a human-readable message on a non-2xx
 * response, so pages can surface it directly.
 */

/**
 * One selectable model, mirroring the backend `ModelInfoSchema` (FR11). `ref` is the exact
 * `provider/model` string handed back to a per-run model override, so the UI never rebuilds it.
 */
export interface ModelInfo {
  ref: string;
  providerID: string;
  modelID: string;
  name: string;
  toolcall: boolean;
  reasoning: boolean;
  /** USD per **1M** tokens. `{ 0, 0 }` is the free tier — see `free`. */
  cost: { input: number; output: number };
  free: boolean;
}

/** One provider and the models it offers, mirroring the backend `ModelProviderSchema`. */
export interface ModelProvider {
  id: string;
  name: string;
  source: string;
  models: ModelInfo[];
}

/**
 * The live model catalog from `GET /api/models` (FR11), mirroring the backend
 * `ModelsResponseSchema`. `default` is the platform's configured default (the free model) — what
 * the backend uses when a request omits a model override.
 */
export interface ModelCatalog {
  default: string;
  providers: ModelProvider[];
}

/** A persisted project, mirroring the backend `ProjectSchema`. */
export interface Project {
  id: string;
  name: string;
  domain: string;
  expectedVolume: string | null;
  warehouse: string;
  servingStyle: string | null;
  createdAt: string;
}

/** Fields accepted by `POST /api/projects`. */
export interface CreateProjectInput {
  name: string;
  domain: string;
  expectedVolume?: string;
  servingStyle?: string;
}

/** An uploaded CSV source, mirroring the backend `SourceSchema`. */
export interface Source {
  id: string;
  projectId: string;
  kind: string;
  path: string;
  originalFilename: string | null;
  rowCount: number | null;
  createdAt: string;
}

/** Per-column profile, mirroring the backend `ColumnProfileSchema` (FR2). */
export interface ColumnProfile {
  name: string;
  type: string;
  nullCount: number;
  nullPercent: number;
  distinctCount: number;
  isCandidateKey: boolean;
  isDateColumn: boolean;
}

/** A profiled CSV source, mirroring the backend `SourceProfileSchema` (FR2). */
export interface SourceProfile {
  rowCount: number;
  columnCount: number;
  columns: ColumnProfile[];
  candidateKeys: string[];
  dateColumns: string[];
}

/** Result of `POST /api/projects/:id/profile`: the updated source and its profile. */
export interface ProfileResult {
  source: Source;
  profile: SourceProfile;
}

/** One ordered pipeline step in an architecture plan, mirroring the backend `PlanStepSchema` (FR3). */
export interface PlanStep {
  name: string;
  description: string;
}

/** A generated architecture plan, mirroring the backend `PlanSchema` (FR3). */
export interface Plan {
  executionPattern: string;
  warehouse: string;
  partitioning: string;
  steps: PlanStep[];
  summary?: string;
}

/** A generated artifact (rules doc, plan, SQL, …), mirroring the backend `ArtifactSchema` (FR6). */
export interface Artifact {
  id: string;
  projectId: string;
  runId: string | null;
  kind: string;
  path: string | null;
  content: string | null;
  createdAt: string;
}

/** Pull an `{ error }` message out of a failed response body, falling back to the status. */
async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body?.error === "string" && body.error.length > 0) {
      return body.error;
    }
  } catch {
    // Non-JSON body — use the fallback below.
  }
  return `${fallback} (${res.status})`;
}

/**
 * Fetch the live model catalog (FR11). The runtime discovers providers from environment keys, so
 * this lists exactly what is reachable right now: with no provider key set, only the free
 * `opencode` models come back. A 503 means the agent runtime is not wired.
 */
export async function listModels(): Promise<ModelCatalog> {
  const res = await fetch("/api/models");
  if (!res.ok) {
    throw new Error(await errorMessage(res, "Failed to load models"));
  }
  return (await res.json()) as ModelCatalog;
}

/** List all projects, newest first. */
export async function listProjects(): Promise<Project[]> {
  const res = await fetch("/api/projects");
  if (!res.ok) {
    throw new Error(await errorMessage(res, "Failed to load projects"));
  }
  const body = (await res.json()) as { projects: Project[] };
  return body.projects;
}

/** Create a project and return the persisted row. */
export async function createProject(input: CreateProjectInput): Promise<Project> {
  const res = await fetch("/api/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    throw new Error(await errorMessage(res, "Failed to create project"));
  }
  return (await res.json()) as Project;
}

/** List a project's uploaded CSV sources, newest first. */
export async function listSources(projectId: string): Promise<Source[]> {
  const res = await fetch(`/api/projects/${projectId}/sources`);
  if (!res.ok) {
    throw new Error(await errorMessage(res, "Failed to load sources"));
  }
  const body = (await res.json()) as { sources: Source[] };
  return body.sources;
}

/**
 * Run the profile stage for a project (FR2). Profiles the given source, or the project's
 * most recent upload when `sourceId` is omitted, returning the schema profile the
 * `SchemaTable` renders plus the source with its now-known row count.
 */
export async function profileSource(
  projectId: string,
  sourceId?: string,
): Promise<ProfileResult> {
  const res = await fetch(`/api/projects/${projectId}/profile`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(sourceId ? { sourceId } : {}),
  });
  if (!res.ok) {
    throw new Error(await errorMessage(res, "Failed to profile source"));
  }
  return (await res.json()) as ProfileResult;
}

/** Upload a CSV file as a source for a project and return the persisted row. */
export async function uploadSource(projectId: string, file: File): Promise<Source> {
  const form = new FormData();
  form.append("file", file, file.name);
  const res = await fetch(`/api/projects/${projectId}/source`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    throw new Error(await errorMessage(res, "Failed to upload source"));
  }
  return (await res.json()) as Source;
}

/** Fetch a project's current rules document (FR6), or `null` if none has been submitted. */
export async function getRules(projectId: string): Promise<Artifact | null> {
  const res = await fetch(`/api/projects/${projectId}/rules`);
  if (!res.ok) {
    throw new Error(await errorMessage(res, "Failed to load rules"));
  }
  const body = (await res.json()) as { rules: Artifact | null };
  return body.rules;
}

/**
 * Save a project's transformation rules from the UI textarea (FR6) as a JSON body, returning
 * the persisted `rules` artifact. Uploading a rules file uses {@link uploadRules} instead.
 */
export async function saveRules(projectId: string, rules: string): Promise<Artifact> {
  const res = await fetch(`/api/projects/${projectId}/rules`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ rules }),
  });
  if (!res.ok) {
    throw new Error(await errorMessage(res, "Failed to save rules"));
  }
  return (await res.json()) as Artifact;
}

/** Result of `POST /api/projects/:id/plan`: the generated plan and its persisted artifact. */
export interface PlanResult {
  plan: Plan;
  artifact: Artifact;
}

/**
 * Generate the architecture plan for a project (FR3). Drives the constrained plan stage on
 * the backend, which profiles the source, reads the current rules, prompts the agent for a
 * structured plan and persists it as a `plan` artifact. An optional `model` (`provider/model`)
 * overrides the default free model for this run.
 */
export async function generatePlan(
  projectId: string,
  options: { sourceId?: string; model?: string } = {},
): Promise<PlanResult> {
  const res = await fetch(`/api/projects/${projectId}/plan`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(options),
  });
  if (!res.ok) {
    throw new Error(await errorMessage(res, "Failed to generate plan"));
  }
  return (await res.json()) as PlanResult;
}

/** A generated transformation, mirroring the backend `TransformSchema` (FR6). */
export interface Transform {
  sql: string;
  targetTable: string;
  assumptions: string[];
  questions: string[];
}

/** Result of `POST /api/projects/:id/transform`: the generated transform and its artifact. */
export interface TransformResult {
  transform: Transform;
  artifact: Artifact;
}

/**
 * Generate the transformation SQL for a project (FR6). Drives the constrained transform stage
 * on the backend, which profiles the source, reads the current rules, prompts the agent for
 * structured SQL plus the assumptions/questions it surfaced, and persists it as a
 * `transform_sql` artifact. An optional `model` (`provider/model`) overrides the free default.
 */
export async function generateTransform(
  projectId: string,
  options: { sourceId?: string; model?: string } = {},
): Promise<TransformResult> {
  const res = await fetch(`/api/projects/${projectId}/transform`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(options),
  });
  if (!res.ok) {
    throw new Error(await errorMessage(res, "Failed to generate transform"));
  }
  return (await res.json()) as TransformResult;
}

/** One generated data-quality check, mirroring the backend `DqCheckSchema` (FR7). */
export interface DqCheck {
  name: string;
  type: "row_count" | "not_null" | "schema" | "freshness";
  column: string | null;
  description: string;
}

/** A generated data-quality spec, mirroring the backend `DqSpecSchema` (FR7). */
export interface DqSpec {
  targetTable: string;
  checks: DqCheck[];
}

/** Result of `POST /api/projects/:id/dq`: the generated DQ spec and its persisted artifact. */
export interface DqResult {
  dq: DqSpec;
  artifact: Artifact;
}

/**
 * Generate the data-quality checks for a project (FR7). Drives the constrained DQ stage on the
 * backend, which profiles the source, reads the current rules, prompts the agent for ≥3
 * structured checks (row count, not-null, schema, freshness) and persists them as a `dq_spec`
 * artifact. An optional `model` (`provider/model`) overrides the default free model for this run.
 */
export async function generateDq(
  projectId: string,
  options: { sourceId?: string; model?: string } = {},
): Promise<DqResult> {
  const res = await fetch(`/api/projects/${projectId}/dq`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(options),
  });
  if (!res.ok) {
    throw new Error(await errorMessage(res, "Failed to generate DQ checks"));
  }
  return (await res.json()) as DqResult;
}

/**
 * The generated artifacts the Review step inspects (FR3/FR6/FR7), mirroring the backend
 * `ReviewArtifactsResponseSchema`. Each is the newest artifact of its kind, or `null` until
 * that generation stage has run. The structured payloads (plan/transform/dq) are stored as
 * JSON in each artifact's `content`; the DDL artifact's `content` is raw SQL.
 */
export interface ReviewArtifacts {
  plan: Artifact | null;
  transform: Artifact | null;
  ddl: Artifact | null;
  dq: Artifact | null;
}

/**
 * Fetch a project's latest generated artifacts (plan, transform SQL, DDL, DQ spec) for the
 * Review step. Returns each as its persisted artifact (content included) so the page can
 * render every payload without a further round-trip; a kind not yet generated comes back null.
 */
export async function getReviewArtifacts(projectId: string): Promise<ReviewArtifacts> {
  const res = await fetch(`/api/projects/${projectId}/artifacts`);
  if (!res.ok) {
    throw new Error(await errorMessage(res, "Failed to load artifacts"));
  }
  return (await res.json()) as ReviewArtifacts;
}

/** Upload a rules document file (FR6) as multipart and return the persisted `rules` artifact. */
export async function uploadRules(projectId: string, file: File): Promise<Artifact> {
  const form = new FormData();
  form.append("file", file, file.name);
  const res = await fetch(`/api/projects/${projectId}/rules`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    throw new Error(await errorMessage(res, "Failed to upload rules"));
  }
  return (await res.json()) as Artifact;
}

/** A run's lifecycle status, mirroring the backend `RUN_STATUSES`. */
export type RunStatus = "pending" | "running" | "success" | "failed" | "rejected";

/** A single stage's status, mirroring the backend `STEP_STATUSES`. */
export type StepStatus = "pending" | "running" | "success" | "failed" | "skipped";

/** A human's decision on a gated stage, mirroring the backend `APPROVAL_ACTIONS`. */
export type ApprovalAction = "approve" | "reject";

/** A persisted pipeline run, mirroring the backend `RunSchema` (FR9). */
export interface Run {
  id: string;
  projectId: string;
  status: RunStatus;
  model: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A persisted per-stage step of a run, mirroring the backend `RunStepSchema` (FR9). */
export interface RunStep {
  id: string;
  runId: string;
  name: string;
  ordinal: number;
  status: StepStatus;
  detail: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

/**
 * A gated stage's pending approval request, mirroring the backend `RunApprovalRequestSchema`
 * (FR8). Carries the exact SQL to be executed when known (the transform), a human-readable
 * summary otherwise, and the tool args — everything the `ApprovalModal` shows before a human
 * approves execution. `requestID` is answered via `POST /api/runs/:runId/approvals/:requestID`.
 */
export interface RunApprovalRequest {
  requestID: string;
  runId: string;
  stepId: string;
  stepName: string;
  tool: string;
  summary: string;
  sql: string | null;
  args: Record<string, unknown>;
}

/** Result of `POST /api/projects/:id/run`: the created run and its ordered pending steps. */
export interface RunResult {
  run: Run;
  steps: RunStep[];
}

/** Result of `GET /api/runs/:runId`: the run, its steps, and any approvals awaiting a human. */
export interface RunState {
  run: Run;
  steps: RunStep[];
  approvals: RunApprovalRequest[];
}

/**
 * A run-progress event streamed over SSE (FR9), mirroring the backend `RunEventSchema`
 * discriminated union: run-level status transitions, per-step status transitions, and the
 * approval request/resolution pair that surfaces the FR8 gate.
 */
export type RunEvent =
  | { kind: "run.status"; runId: string; status: RunStatus }
  | {
      kind: "step.status";
      runId: string;
      stepId: string;
      name: string;
      status: StepStatus;
      detail: string | null;
    }
  | { kind: "approval.requested"; runId: string; request: RunApprovalRequest }
  | { kind: "approval.resolved"; runId: string; requestID: string; action: ApprovalAction };

/** The named SSE channels the run-events stream publishes, one per {@link RunEvent} kind. */
const RUN_EVENT_KINDS: RunEvent["kind"][] = [
  "run.status",
  "step.status",
  "approval.requested",
  "approval.resolved",
];

/**
 * Start a pipeline run for a project (FR8/FR9). The backend resolves the source and the reviewed
 * transform, creates the run plus one pending step per stage, launches the scripted runner in the
 * background and returns 202 immediately — the run then pauses at each gated stage for approval.
 * Subscribe to {@link subscribeRunEvents} for progress and answer gates via {@link resolveRunApproval}.
 */
export async function startRun(
  projectId: string,
  options: { sourceId?: string; model?: string } = {},
): Promise<RunResult> {
  const res = await fetch(`/api/projects/${projectId}/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(options),
  });
  if (!res.ok) {
    throw new Error(await errorMessage(res, "Failed to start run"));
  }
  return (await res.json()) as RunResult;
}

/**
 * Fetch a run's current state (FR9/FR12): the run row, its ordered steps, and any approvals still
 * awaiting a human. Used to reconcile after (re)connecting — a gated stage that requested approval
 * before the SSE stream connected stays pending here, so this recovers it rather than deadlocking.
 */
export async function getRunState(runId: string): Promise<RunState> {
  const res = await fetch(`/api/runs/${runId}`);
  if (!res.ok) {
    throw new Error(await errorMessage(res, "Failed to load run"));
  }
  return (await res.json()) as RunState;
}

/**
 * Answer a run's gated stage (FR8): approve lets the tool run once, reject aborts the run. The
 * backend records the decision to the run's lineage (FR12) and unblocks the parked runner.
 */
export async function resolveRunApproval(
  runId: string,
  requestID: string,
  action: ApprovalAction,
): Promise<void> {
  const res = await fetch(`/api/runs/${runId}/approvals/${requestID}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action }),
  });
  if (!res.ok) {
    throw new Error(await errorMessage(res, "Failed to submit approval"));
  }
}

/** A recorded tool call's lifecycle, mirroring the backend `TOOL_CALL_STATUSES`. */
export type ToolCallStatus = "running" | "success" | "failed";

/**
 * One recorded tool invocation, mirroring the backend `RunToolCallSchema` (FR12). `args` is `null`
 * when nothing usable was recorded, which the detail view must show as "not recorded" rather than
 * as an empty arg map.
 */
export interface RunToolCall {
  id: string;
  runId: string;
  stepId: string;
  tool: string;
  args: Record<string, unknown> | null;
  status: ToolCallStatus;
  result: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

/**
 * One recorded approval decision, mirroring the backend `RunApprovalRecordSchema` (FR8/FR12) — the
 * audit trail proving every executed write tool was approved by a human first.
 */
export interface RunApprovalRecord {
  id: string;
  runId: string;
  requestId: string;
  tool: string;
  args: Record<string, unknown> | null;
  action: ApprovalAction;
  createdAt: string;
  decidedAt: string | null;
}

/**
 * One recorded DQ check outcome, mirroring the backend `RunDqResultSchema` (FR7/FR12). A `passed:
 * false` row here is what blocked the run's publish stage.
 */
export interface RunDqResult {
  id: string;
  runId: string;
  checkName: string;
  passed: boolean;
  detail: string | null;
  createdAt: string;
}

/**
 * A run's complete lineage (FR12), mirroring the backend `RunLineageSchema`: the run, its steps,
 * every tool call, every approval decision, and every DQ result. Each list is independently empty —
 * a run rejected at its first gate has steps and one approval but no tool calls and no DQ results.
 */
export interface RunLineage {
  run: Run;
  steps: RunStep[];
  toolCalls: RunToolCall[];
  approvals: RunApprovalRecord[];
  dqResults: RunDqResult[];
}

/**
 * Fetch one run's complete lineage (FR12) for the run detail view. Distinct from
 * {@link getRunState}, which serves a *live* run's state plus the approvals still awaiting an
 * answer; this is the after-the-fact audit record of what actually happened.
 */
export async function getRunLineage(runId: string): Promise<RunLineage> {
  const res = await fetch(`/api/runs/${runId}/lineage`);
  if (!res.ok) {
    throw new Error(await errorMessage(res, "Failed to load run lineage"));
  }
  return (await res.json()) as RunLineage;
}

/**
 * List a project's runs, newest first (FR12) — the history the run detail view is opened from. A
 * project that has never run returns an empty list rather than an error.
 */
export async function listRuns(projectId: string): Promise<Run[]> {
  const res = await fetch(`/api/projects/${projectId}/runs`);
  if (!res.ok) {
    throw new Error(await errorMessage(res, "Failed to load runs"));
  }
  return ((await res.json()) as { runs: Run[] }).runs;
}

/**
 * A published table in the served registry (FR10), mirroring the backend `ServedTableSchema`.
 * `name` is the identity — it is the URL segment the generated endpoints are reached at — and
 * `endpoint`/`csvEndpoint` are the ready-to-use URLs the backend derives, so the UI renders them
 * rather than rebuilding them from a route prefix it would have to keep in sync.
 */
export interface ServedTable {
  name: string;
  projectId: string;
  runId: string | null;
  schema: string;
  table: string;
  qualifiedTable: string;
  format: string;
  rowCount: number;
  csvPath: string;
  endpoint: string;
  csvEndpoint: string;
  publishedAt: string;
}

/** A served table's column, mirroring the backend `ServedColumnSchema`. */
export interface ServedColumn {
  name: string;
  type: string;
}

/**
 * One cell of served data, mirroring the backend `ServedCellSchema`. The backend coerces every
 * warehouse value into one of these, so a `BIGINT` beyond JSON's safe-integer range arrives as a
 * string rather than a silently rounded number.
 */
export type ServedCell = string | number | boolean | null;

/**
 * A page of a served table, mirroring the backend `ServedDataSchema` (FR10). `rowCount` is the
 * **total** rows served, not `rows.length` — a client showing one page still learns how much
 * there is. Row order is whatever the published export holds; the pipeline does not guarantee one.
 */
export interface ServedData {
  name: string;
  schema: string;
  table: string;
  qualifiedTable: string;
  format: string;
  endpoint: string;
  csvEndpoint: string;
  publishedAt: string;
  columns: ServedColumn[];
  rowCount: number;
  rows: Record<string, ServedCell>[];
  limit: number;
  offset: number;
}

/**
 * List the tables a project has published (FR10), newest first. The registry is keyed by served
 * name while the wizard carries a project, so this is how the Serve step finds the endpoints a
 * project's run generated. An empty list means the project has not published yet.
 */
export async function listServedTables(projectId: string): Promise<ServedTable[]> {
  const res = await fetch(`/api/projects/${projectId}/served`);
  if (!res.ok) {
    throw new Error(await errorMessage(res, "Failed to load served tables"));
  }
  const body = (await res.json()) as { served: ServedTable[] };
  return body.served;
}

/**
 * Read a page of a served table from its generated REST endpoint (FR10) — the same endpoint an
 * external caller would hit, so the preview exercises the real contract rather than a private
 * view of it. Serves the published export: the snapshot that passed DQ and was approved.
 */
export async function getServedData(
  name: string,
  options: { limit?: number; offset?: number } = {},
): Promise<ServedData> {
  const query = new URLSearchParams();
  if (options.limit !== undefined) query.set("limit", String(options.limit));
  if (options.offset !== undefined) query.set("offset", String(options.offset));
  const suffix = query.toString();
  const res = await fetch(`/api/serve/${name}${suffix ? `?${suffix}` : ""}`);
  if (!res.ok) {
    throw new Error(await errorMessage(res, "Failed to load served data"));
  }
  return (await res.json()) as ServedData;
}

/**
 * Subscribe to a run's progress events over SSE (FR9). Opens an `EventSource` on
 * `GET /api/runs/:runId/events` and invokes `onEvent` for every {@link RunEvent} the runner emits
 * (each arrives on a named channel matching its `kind`). Returns an unsubscribe function that
 * closes the stream; call it when the component unmounts or the run changes.
 */
export function subscribeRunEvents(
  runId: string,
  onEvent: (event: RunEvent) => void,
): () => void {
  const source = new EventSource(`/api/runs/${runId}/events`);
  const listener = (event: MessageEvent) => {
    try {
      onEvent(JSON.parse(event.data) as RunEvent);
    } catch {
      // Ignore a malformed frame rather than tearing down the whole stream.
    }
  };
  for (const kind of RUN_EVENT_KINDS) {
    source.addEventListener(kind, listener as EventListener);
  }
  return () => source.close();
}
