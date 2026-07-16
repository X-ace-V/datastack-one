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
