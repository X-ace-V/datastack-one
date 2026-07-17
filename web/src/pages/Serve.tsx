import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { StepShell } from "../components/StepShell";
import { DataTable } from "../components/DataTable";
import { ServingDashboard } from "../components/ServingDashboard";
import {
  getServedData,
  listProjects,
  listServedTables,
  type Project,
  type ServedData,
  type ServedTable,
} from "../lib/api";

/**
 * Step 6 — serve the published report (T5.4, FR10). For the selected project this lists what its
 * pipeline published (`GET /api/projects/:id/served`), then reads the chosen table back through
 * its **own generated REST endpoint** (`GET /api/serve/:name`) — the same URL an external caller
 * would hit, so the preview exercises the real contract rather than a private view of it. The
 * page shows that endpoint, a CSV download link, the mini dashboard, and the table preview.
 *
 * A project with no published table is a normal pre-run state (its run has not reached a
 * successful publish), so the page says so and links back to Run rather than erroring.
 */
export function ServePage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [served, setServed] = useState<ServedTable[]>([]);
  const [name, setName] = useState("");
  const [data, setData] = useState<ServedData | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load projects on mount and default the selection to the newest one.
  useEffect(() => {
    let active = true;
    listProjects()
      .then((list) => {
        if (!active) return;
        setProjects(list);
        if (list.length > 0 && list[0]) setProjectId(list[0].id);
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      active = false;
    };
  }, []);

  // Whenever the project changes, list what it has published and select its newest endpoint.
  useEffect(() => {
    if (!projectId) return;
    let active = true;
    setLoaded(false);
    setData(null);
    setError(null);
    listServedTables(projectId)
      .then((tables) => {
        if (!active) return;
        setServed(tables);
        setName(tables[0]?.name ?? "");
        setLoaded(true);
      })
      .catch((err: unknown) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoaded(true);
      });
    return () => {
      active = false;
    };
  }, [projectId]);

  // Read the selected endpoint's data through the generated REST endpoint itself.
  useEffect(() => {
    if (!name) return;
    let active = true;
    setError(null);
    getServedData(name)
      .then((result) => {
        if (active) setData(result);
      })
      .catch((err: unknown) => {
        if (!active) return;
        setData(null);
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      active = false;
    };
  }, [name]);

  if (projects.length === 0) {
    return (
      <StepShell slug="serve">
        <p className="mt-4 text-sm text-slate-600">
          No projects yet.{" "}
          <Link to="/create" className="font-medium text-indigo-600 hover:underline">
            Create a project first →
          </Link>
        </p>
        {error && (
          <p role="alert" className="mt-4 text-sm text-red-600">
            {error}
          </p>
        )}
      </StepShell>
    );
  }

  const current = served.find((table) => table.name === name) ?? null;

  return (
    <StepShell slug="serve">
      <div className="mt-4 space-y-4">
        <div className="flex flex-wrap gap-4">
          <div className="min-w-56 flex-1">
            <label htmlFor="serve-project" className="block text-sm font-medium text-slate-700">
              Project
            </label>
            <select
              id="serve-project"
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            >
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name} — {project.domain}
                </option>
              ))}
            </select>
          </div>

          {served.length > 1 && (
            <div className="min-w-56 flex-1">
              <label htmlFor="serve-table" className="block text-sm font-medium text-slate-700">
                Published table
              </label>
              <select
                id="serve-table"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              >
                {served.map((table) => (
                  <option key={table.name} value={table.name}>
                    {table.name}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}

        {loaded && served.length === 0 && (
          <p className="text-sm text-slate-600">
            This project has not published a table yet.{" "}
            <Link to="/run" className="font-medium text-indigo-600 hover:underline">
              Run the pipeline →
            </Link>
          </p>
        )}

        {current && (
          <section
            role="region"
            aria-label="Generated endpoints"
            className="space-y-2 rounded-md border border-slate-200 bg-slate-50 p-3"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-xs font-medium text-slate-500">REST endpoint</p>
                <p className="truncate font-mono text-sm text-slate-800">
                  GET {current.endpoint}
                </p>
              </div>
              <a
                href={current.csvEndpoint}
                download
                className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700"
              >
                Download CSV
              </a>
            </div>
            <p className="text-xs text-slate-500">
              Serving <span className="font-mono">{current.qualifiedTable}</span> — the export
              published at {current.publishedAt.slice(0, 16)} after its data-quality checks passed.
            </p>
          </section>
        )}

        {data && (
          <>
            <ServingDashboard data={data} />
            <DataTable data={data} />
          </>
        )}
      </div>
    </StepShell>
  );
}
