/**
 * Typed client for the DataStack One backend REST API. The Vite dev server proxies
 * `/api/*` to the Fastify backend (see web/vite.config.ts), so these use same-origin
 * relative URLs. Each call throws an `Error` with a human-readable message on a non-2xx
 * response, so pages can surface it directly.
 */

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
