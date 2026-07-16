import { useEffect, useRef, useState, type DragEvent } from "react";
import { Link } from "react-router-dom";
import { StepShell } from "../components/StepShell";
import {
  listProjects,
  listSources,
  uploadSource,
  type Project,
  type Source,
} from "../lib/api";

/**
 * Step 2 — connect a CSV source (FR2). Pick a project, then upload a loan CSV by drag-drop
 * or file picker. The upload posts multipart to `POST /api/projects/:id/source`; on success
 * the new source is prepended to the project's source list. Profiling the schema is the next
 * step (T2.4). The wizard does not thread a project id in the URL, so the project is chosen
 * here from the existing list (defaulting to the most recent).
 */
export function ConnectPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [sources, setSources] = useState<Source[]>([]);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploaded, setUploaded] = useState<Source | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

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

  // Whenever the selected project changes, load its existing sources.
  useEffect(() => {
    if (!projectId) {
      setSources([]);
      return;
    }
    let active = true;
    listSources(projectId)
      .then((list) => {
        if (active) setSources(list);
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      active = false;
    };
  }, [projectId]);

  async function handleFile(file: File) {
    if (!projectId) {
      setError("Select a project before uploading.");
      return;
    }
    setUploading(true);
    setError(null);
    setUploaded(null);
    try {
      const source = await uploadSource(projectId, file);
      setSources((prev) => [source, ...prev]);
      setUploaded(source);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (file) void handleFile(file);
  }

  if (projects.length === 0) {
    return (
      <StepShell slug="connect">
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

  return (
    <StepShell slug="connect">
      <div className="mt-4 space-y-4">
        <div>
          <label htmlFor="connect-project" className="block text-sm font-medium text-slate-700">
            Project
          </label>
          <select
            id="connect-project"
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

        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          onClick={() => inputRef.current?.click()}
          role="button"
          tabIndex={0}
          aria-label="Upload CSV"
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") inputRef.current?.click();
          }}
          className={[
            "flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed px-6 py-10 text-center text-sm transition-colors",
            dragging
              ? "border-indigo-500 bg-indigo-50 text-indigo-700"
              : "border-slate-300 text-slate-500 hover:border-slate-400",
          ].join(" ")}
        >
          <p className="font-medium">
            {uploading ? "Uploading…" : "Drag a CSV here, or click to choose a file"}
          </p>
          <p className="mt-1 text-xs text-slate-400">.csv only</p>
          <input
            ref={inputRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            aria-label="CSV file"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleFile(file);
              e.target.value = "";
            }}
          />
        </div>

        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}

        {uploaded && (
          <p role="status" className="text-sm text-slate-700">
            Uploaded “{uploaded.originalFilename ?? uploaded.id}”.{" "}
            <Link to="/plan" className="font-medium text-indigo-600 hover:underline">
              Continue to Plan →
            </Link>
          </p>
        )}

        <section aria-label="Uploaded sources">
          <h2 className="text-sm font-semibold text-slate-700">Uploaded sources</h2>
          {sources.length === 0 ? (
            <p className="mt-2 text-sm text-slate-500">No sources uploaded yet.</p>
          ) : (
            <ul className="mt-2 divide-y divide-slate-200 rounded-md border border-slate-200">
              {sources.map((source) => (
                <li key={source.id} className="px-3 py-2 text-sm">
                  <span className="font-medium text-slate-900">
                    {source.originalFilename ?? source.id}
                  </span>
                  <span className="text-slate-500"> — {source.kind}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </StepShell>
  );
}
