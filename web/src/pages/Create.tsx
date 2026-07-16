import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { StepShell } from "../components/StepShell";
import { createProject, listProjects, type Project } from "../lib/api";

/**
 * Step 1 — create a project (FR1). Posts to `POST /api/projects` and lists existing
 * projects from `GET /api/projects`. On a successful create the new project is prepended
 * to the list and a link to the next step appears. The warehouse is DuckDB-only in the
 * MVP, so it is shown as a fixed field rather than a choice.
 */
export function CreatePage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [name, setName] = useState("");
  const [domain, setDomain] = useState("");
  const [expectedVolume, setExpectedVolume] = useState("");
  const [servingStyle, setServingStyle] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Project | null>(null);

  useEffect(() => {
    let active = true;
    listProjects()
      .then((list) => {
        if (active) setProjects(list);
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      active = false;
    };
  }, []);

  const canSubmit = name.trim().length > 0 && domain.trim().length > 0 && !submitting;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const project = await createProject({
        name: name.trim(),
        domain: domain.trim(),
        expectedVolume: expectedVolume.trim() || undefined,
        servingStyle: servingStyle.trim() || undefined,
      });
      setProjects((prev) => [project, ...prev]);
      setCreated(project);
      setName("");
      setDomain("");
      setExpectedVolume("");
      setServingStyle("");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  const fieldClass =
    "mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm " +
    "focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500";

  return (
    <StepShell slug="create">
      <form onSubmit={handleSubmit} aria-label="Create project" className="mt-4 space-y-4">
        <div>
          <label htmlFor="project-name" className="block text-sm font-medium text-slate-700">
            Project name
          </label>
          <input
            id="project-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            placeholder="Loan Book"
            className={fieldClass}
          />
        </div>

        <div>
          <label htmlFor="project-domain" className="block text-sm font-medium text-slate-700">
            Business domain
          </label>
          <input
            id="project-domain"
            type="text"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            required
            placeholder="lending"
            className={fieldClass}
          />
        </div>

        <div>
          <label
            htmlFor="project-volume"
            className="block text-sm font-medium text-slate-700"
          >
            Expected volume <span className="text-slate-400">(optional)</span>
          </label>
          <input
            id="project-volume"
            type="text"
            value={expectedVolume}
            onChange={(e) => setExpectedVolume(e.target.value)}
            placeholder="10M rows/day"
            className={fieldClass}
          />
        </div>

        <div>
          <label
            htmlFor="project-serving"
            className="block text-sm font-medium text-slate-700"
          >
            Serving style <span className="text-slate-400">(optional)</span>
          </label>
          <input
            id="project-serving"
            type="text"
            value={servingStyle}
            onChange={(e) => setServingStyle(e.target.value)}
            placeholder="rest"
            className={fieldClass}
          />
        </div>

        <div>
          <label htmlFor="project-warehouse" className="block text-sm font-medium text-slate-700">
            Warehouse
          </label>
          <input
            id="project-warehouse"
            type="text"
            value="duckdb"
            readOnly
            aria-readonly="true"
            className={`${fieldClass} bg-slate-100 text-slate-500`}
          />
        </div>

        <button
          type="submit"
          disabled={!canSubmit}
          className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? "Creating…" : "Create project"}
        </button>
      </form>

      {error && (
        <p role="alert" className="mt-4 text-sm text-red-600">
          {error}
        </p>
      )}

      {created && (
        <p role="status" className="mt-4 text-sm text-slate-700">
          Created project “{created.name}” (<code>{created.id}</code>).{" "}
          <Link to="/connect" className="font-medium text-indigo-600 hover:underline">
            Continue to Connect →
          </Link>
        </p>
      )}

      <section aria-label="Existing projects" className="mt-8">
        <h2 className="text-sm font-semibold text-slate-700">Existing projects</h2>
        {projects.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500">No projects yet.</p>
        ) : (
          <ul className="mt-2 divide-y divide-slate-200 rounded-md border border-slate-200">
            {projects.map((project) => (
              <li key={project.id} className="px-3 py-2 text-sm">
                <span className="font-medium text-slate-900">{project.name}</span>
                <span className="text-slate-500"> — {project.domain}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </StepShell>
  );
}
