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
