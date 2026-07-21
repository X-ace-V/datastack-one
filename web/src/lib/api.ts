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

/** A legacy project upload, mirroring the backend `SourceSchema`. */
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

/**
 * A persisted chat session, mirroring the backend `SessionSchema` (FR1). `model` is the
 * per-session default (null → the platform default). `updatedAt` bumps on rename and on each
 * appended message, so the sidebar orders sessions by recent activity.
 */
export interface Session {
  id: string;
  title: string;
  model: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * One rendered block of a persisted assistant turn (V6.2) — the durable mirror of the store's
 * `InlineBlock`, minus the transient `approval` pill. Reopening a session reconstructs a turn's
 * tool-block history from these. Kept in sync with the backend `PersistedBlockSchema`.
 */
export type PersistedBlock =
  | { kind: "text"; partID: string; text: string }
  | { kind: "reasoning"; partID: string; text: string }
  | {
      kind: "tool";
      callID: string;
      tool: string;
      status: "pending" | "running" | "completed" | "error";
      input?: Record<string, unknown>;
      output?: string;
      error?: string;
      title?: string;
      metadata?: Record<string, unknown>;
    };

/** One persisted transcript message, mirroring the backend `MessageSchema` (FR1). */
export interface Message {
  id: string;
  sessionId: string;
  seq: number;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  /** An assistant turn's ordered rendered blocks (V6.2); absent on a user message. */
  blocks?: PersistedBlock[];
  attachments?: AttachmentRef[];
}

export interface AttachmentRef {
  name: string;
  kind: string;
}

/** A session together with its ordered history, mirroring `SessionWithHistorySchema` (FR1). */
export interface SessionWithHistory extends Session {
  messages: Message[];
}

/** Fields accepted by `POST /api/sessions`; both optional (an untitled create is allowed). */
export interface CreateSessionInput {
  title?: string;
  model?: string;
  /** Start OpenCode with this authorized local folder as the session's immutable cwd. */
  folderPath?: string;
}

/** List all chat sessions, most recently active first, for the sidebar (V2.3). */
export async function listSessions(): Promise<Session[]> {
  const res = await fetch("/api/sessions");
  if (!res.ok) {
    throw new Error(await errorMessage(res, "Failed to load sessions"));
  }
  const body = (await res.json()) as { sessions: Session[] };
  return body.sessions;
}

/** OpenCode's live execution state for one chat session. */
export type SessionRuntimeStatus =
  | { type: "idle" }
  | { type: "busy" }
  | { type: "retry"; attempt?: number; message?: string; next?: number };

/** Recover all currently active OpenCode session states after a page reload/reconnect. */
export async function listSessionStatuses(): Promise<Record<string, SessionRuntimeStatus>> {
  const res = await fetch("/api/sessions/status");
  if (!res.ok) {
    throw new Error(await errorMessage(res, "Failed to load session statuses"));
  }
  const body = (await res.json()) as { statuses: Record<string, SessionRuntimeStatus> };
  return body.statuses ?? {};
}

/** Create a chat session and return the persisted row (201). */
export async function createSession(input: CreateSessionInput = {}): Promise<Session> {
  const res = await fetch("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    throw new Error(await errorMessage(res, "Failed to create session"));
  }
  return (await res.json()) as Session;
}

/** Fetch a session together with its ordered message history (FR1) — the shape a reopen needs. */
export async function getSession(id: string): Promise<SessionWithHistory> {
  const res = await fetch(`/api/sessions/${id}`);
  if (!res.ok) {
    throw new Error(await errorMessage(res, "Failed to load session"));
  }
  return (await res.json()) as SessionWithHistory;
}

/**
 * A session's registered source, path-free (mirrors the backend `SessionSourceView`). The on-disk
 * path is never sent to the browser or the model (FR5b).
 */
export interface SessionSourceView {
  sessionId: string;
  name: string;
  kind: string;
  origin: "upload" | "folder" | "connection";
  relativePath: string | null;
  rowCount: number | null;
  createdAt: string;
}

/**
 * Upload a supported data/project file into a session (FR4). Posts multipart/form-data; the backend registers it under a
 * name derived from the filename so the agent's `list_sources`/`profile_source` tools see it.
 * Returns the registered source (path withheld).
 */
export async function uploadSessionSource(
  sessionId: string,
  file: File,
): Promise<SessionSourceView> {
  const form = new FormData();
  form.append("file", file, file.name);
  const res = await fetch(`/api/sessions/${sessionId}/sources`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    throw new Error(await errorMessage(res, "Failed to upload file"));
  }
  const body = (await res.json()) as { source: SessionSourceView };
  return body.source;
}

export async function listSessionSources(sessionId: string): Promise<SessionSourceView[]> {
  const res = await fetch(`/api/sessions/${sessionId}/sources`);
  if (!res.ok) throw new Error(await errorMessage(res, "Failed to list session files"));
  return ((await res.json()) as { sources: SessionSourceView[] }).sources;
}

export interface SessionFolder {
  sessionId: string;
  name: string;
  path: string;
  workspaceRoot: boolean;
  connectedAt: string;
}

export interface WorkspaceFile {
  path: string;
  name: string;
  kind: string;
  size: number;
  modifiedAt: string;
  queryable: boolean;
  sourceName?: string;
}

export interface FolderEntry {
  name: string;
  path: string;
}

export interface FolderBrowseResult {
  path: string | null;
  parent: string | null;
  folders: FolderEntry[];
}

export interface SessionFolderResult {
  folder: SessionFolder | null;
  files: WorkspaceFile[];
}

export async function browseFolders(path?: string): Promise<FolderBrowseResult> {
  const query = path ? `?path=${encodeURIComponent(path)}` : "";
  const res = await fetch(`/api/folders${query}`);
  if (!res.ok) throw new Error(await errorMessage(res, "Failed to browse folders"));
  return (await res.json()) as FolderBrowseResult;
}

export async function getSessionFolder(sessionId: string): Promise<SessionFolderResult> {
  const res = await fetch(`/api/sessions/${sessionId}/folder`);
  if (!res.ok) throw new Error(await errorMessage(res, "Failed to load connected folder"));
  return (await res.json()) as SessionFolderResult;
}

export async function refreshSessionFolder(sessionId: string): Promise<SessionFolderResult> {
  const res = await fetch(`/api/sessions/${sessionId}/folder/refresh`, { method: "POST" });
  if (!res.ok) throw new Error(await errorMessage(res, "Failed to refresh folder"));
  return (await res.json()) as SessionFolderResult;
}

/**
 * One row of a session's lineage/audit trail, mirroring the backend `LineageEventSchema` (FR12).
 * `kind` discriminates the event; `tool`/`status` are set per kind; `detail` is the kind-specific
 * payload (write args + result, reviewed approval metadata, or DQ check outcomes).
 */
export interface LineageEvent {
  id: string;
  sessionId: string;
  runId: string | null;
  seq: number;
  kind: "tool_call" | "approval" | "dq_result";
  tool: string | null;
  status:
    | "completed"
    | "error"
    | "rejected"
    | "approved"
    | "passed"
    | "failed"
    | null;
  detail: Record<string, unknown> | null;
  createdAt: string;
}

/**
 * Fetch a session's lineage/audit trail in `seq` order (FR12) — the write tool calls, the
 * approvals answered, and the DQ results the run/lineage view renders.
 */
export async function getSessionLineage(sessionId: string): Promise<LineageEvent[]> {
  const res = await fetch(`/api/sessions/${sessionId}/lineage`);
  if (!res.ok) {
    throw new Error(await errorMessage(res, "Failed to load lineage"));
  }
  const body = (await res.json()) as { lineage: LineageEvent[] };
  return body.lineage;
}

/** Rename a session (title required) and return the updated row (FR1). */
export async function renameSession(id: string, title: string): Promise<Session> {
  const res = await fetch(`/api/sessions/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) {
    throw new Error(await errorMessage(res, "Failed to rename session"));
  }
  return (await res.json()) as Session;
}

/**
 * Set a session's per-session model (V6.1, FR11) via `PATCH /api/sessions/:id`. The picker sends
 * the chosen `provider/model` ref, or `null` to clear the override back to the platform default.
 * Returns the updated session row so the caller reflects the persisted value.
 */
export async function updateSessionModel(
  id: string,
  model: string | null,
): Promise<Session> {
  const res = await fetch(`/api/sessions/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model }),
  });
  if (!res.ok) {
    throw new Error(await errorMessage(res, "Failed to update model"));
  }
  return (await res.json()) as Session;
}

/** Delete a session and its entire message history (FR1). Resolves on the 204 No Content. */
export async function deleteSession(id: string): Promise<void> {
  const res = await fetch(`/api/sessions/${id}`, { method: "DELETE" });
  if (!res.ok) {
    throw new Error(await errorMessage(res, "Failed to delete session"));
  }
}

/**
 * Send a natural-language turn to a session (FR2). The backend persists the user turn and fires
 * it at the agent, returning fast (202) with the persisted user message; the assistant's
 * reasoning, tool calls, and reply stream back over the SSE event stream, not this response.
 * An optional `model` overrides the model for this single turn.
 */
export async function sendChat(
  sessionId: string,
  text: string,
  model?: string,
  attachments: AttachmentRef[] = [],
): Promise<Message> {
  const res = await fetch(`/api/sessions/${sessionId}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      text,
      ...(model ? { model } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
    }),
  });
  if (!res.ok) {
    throw new Error(await errorMessage(res, "Failed to send message"));
  }
  return (await res.json()) as Message;
}

/** Cancel the in-flight turn on a session (FR2) via `session.abort`. Resolves on the 200. */
export async function cancelChat(sessionId: string): Promise<void> {
  const res = await fetch(`/api/sessions/${sessionId}/cancel`, { method: "POST" });
  if (!res.ok) {
    throw new Error(await errorMessage(res, "Failed to cancel turn"));
  }
}

/** A human's decision on a pending inline approval (FR10), mirroring the backend `ApprovalAction`. */
export type ApprovalAction = "approve" | "reject";

/**
 * The audit record returned by `POST /api/approvals/:requestID`, mirroring the backend
 * `ApprovalResultSchema`: the request answered, the action taken, the gated tool type, and the
 * terminal status the pill shows.
 */
export interface ApprovalResult {
  requestID: string;
  action: ApprovalAction;
  type: string;
  status: "approved" | "rejected";
}

/**
 * Answer a pending inline approval (FR10) — relay a human's approve/reject for a paused write
 * tool to `POST /api/approvals/:requestID`. Approve runs the gated call once; reject aborts it.
 * The resolved status also streams back as an `approval_resolved` event, which clears the pill.
 */
export async function answerApproval(
  requestID: string,
  action: ApprovalAction,
): Promise<ApprovalResult> {
  const res = await fetch(`/api/approvals/${requestID}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action }),
  });
  if (!res.ok) {
    throw new Error(await errorMessage(res, "Failed to answer approval"));
  }
  return (await res.json()) as ApprovalResult;
}

/** User response to OpenCode's interactive `question` tool. */
export type QuestionDecision =
  | { action: "answer"; answers: string[][] }
  | { action: "reject" };

export interface QuestionResult {
  requestID: string;
  action: "answer" | "reject";
  status: "answered" | "rejected";
  answers?: string[][];
}

/** Resume a paused question tool with ordered answers, or reject it. */
export async function answerQuestion(
  requestID: string,
  decision: QuestionDecision,
): Promise<QuestionResult> {
  const res = await fetch(`/api/questions/${requestID}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(decision),
  });
  if (!res.ok) {
    throw new Error(await errorMessage(res, "Failed to answer question"));
  }
  return (await res.json()) as QuestionResult;
}

/** Snapshot used to recover interactions missed before the SSE stream connected. */
export interface PendingInteractions {
  approvals: Array<{
    requestID: string;
    sessionID: string;
    type: string;
    metadata: Record<string, unknown>;
    callID?: string;
    patterns?: string[];
  }>;
  questions: Array<{
    requestID: string;
    sessionID: string;
    questions: Array<{
      question: string;
      header: string;
      options: Array<{ label: string; description: string }>;
      multiple?: boolean;
      custom?: boolean;
    }>;
    messageID?: string;
    callID?: string;
  }>;
}

/** Load every pending human interaction across all independently-running sessions. */
export async function listPendingInteractions(): Promise<PendingInteractions> {
  const res = await fetch("/api/interactions");
  if (!res.ok) {
    throw new Error(await errorMessage(res, "Failed to recover pending interactions"));
  }
  const body = (await res.json()) as Partial<PendingInteractions>;
  return { approvals: body.approvals ?? [], questions: body.questions ?? [] };
}

/**
 * A registered database connection, mirroring the backend `ConnectionSchema` (FR5). The
 * credentialed `url` is deliberately absent from the shape — it is entered once in the Settings →
 * Connections panel, posts to the server, and never comes back, so the browser cannot leak it.
 */
export interface Connection {
  name: string;
  type: string;
  createdAt: string;
}

/** Fields accepted by `POST /api/connections`; `type` defaults to `postgres` server-side. */
export interface CreateConnectionInput {
  name: string;
  url: string;
  type?: string;
}

/** The outcome of a test-connection probe, mirroring the backend `ConnectionTestResultSchema`. */
export interface ConnectionTestResult {
  ok: boolean;
  error: string | null;
}

/**
 * List the registered connections (FR5), name/type/createdAt only. The response never carries a
 * secret — the backend's list shape has no `url` field — so this is safe to hold in the browser.
 */
export async function listConnections(): Promise<Connection[]> {
  const res = await fetch("/api/connections");
  if (!res.ok) {
    throw new Error(await errorMessage(res, "Failed to load connections"));
  }
  const body = (await res.json()) as { connections: Connection[] };
  return body.connections ?? [];
}

/**
 * Register a database connection (FR5). This is the ONLY call a credentialed URL is sent on; it
 * posts to the server, which stores the secret gitignored server-side and returns the secret-free
 * view. The caller must clear the URL from its own state after this resolves.
 */
export async function createConnection(
  input: CreateConnectionInput,
): Promise<Connection> {
  const res = await fetch("/api/connections", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    throw new Error(await errorMessage(res, "Failed to add connection"));
  }
  const body = (await res.json()) as { connection: Connection };
  return body.connection;
}

/** Remove a registered connection by name (FR5). Resolves on the 204 No Content. */
export async function deleteConnection(name: string): Promise<void> {
  const res = await fetch(`/api/connections/${encodeURIComponent(name)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    throw new Error(await errorMessage(res, "Failed to remove connection"));
  }
}

/**
 * Test a registered connection (FR5). The backend resolves the name → its stored URL and probes it
 * read-only; the result carries only `{ ok, error }` with any credential scrubbed — the URL never
 * leaves the server, so the browser learns whether the connection works without ever seeing it.
 */
export async function testConnection(name: string): Promise<ConnectionTestResult> {
  const res = await fetch(`/api/connections/${encodeURIComponent(name)}/test`, {
    method: "POST",
  });
  if (!res.ok) {
    throw new Error(await errorMessage(res, "Failed to test connection"));
  }
  const body = (await res.json()) as { result: ConnectionTestResult };
  return body.result;
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
