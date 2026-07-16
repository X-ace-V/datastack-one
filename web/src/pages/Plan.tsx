import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { StepShell } from "../components/StepShell";
import {
  getRules,
  listProjects,
  saveRules,
  uploadRules,
  type Artifact,
  type Project,
} from "../lib/api";

/**
 * Step 3 — provide the plain-English transformation rules the agent will turn into SQL (FR6,
 * T3.1). Rules can be entered two ways (PRD §9.3): typed into the textarea, or uploaded as a
 * file. Either way they post to `POST /api/projects/:id/rules` and are stored as a `rules`
 * artifact; the current rules doc on file is loaded on mount. Generating the plan from these
 * rules is the next step (T3.2). The wizard does not thread a project id in the URL, so the
 * project is chosen here from the existing list (defaulting to the most recent).
 */
export function PlanPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [rulesText, setRulesText] = useState("");
  const [current, setCurrent] = useState<Artifact | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
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

  // Whenever the selected project changes, load its current rules doc into the editor.
  useEffect(() => {
    setSaved(false);
    setCurrent(null);
    setRulesText("");
    if (!projectId) return;
    let active = true;
    getRules(projectId)
      .then((rules) => {
        if (!active) return;
        setCurrent(rules);
        if (rules?.content) setRulesText(rules.content);
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      active = false;
    };
  }, [projectId]);

  async function handleSaveText() {
    if (!projectId) {
      setError("Select a project first.");
      return;
    }
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const artifact = await saveRules(projectId, rulesText);
      setCurrent(artifact);
      setSaved(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleUpload(file: File) {
    if (!projectId) {
      setError("Select a project first.");
      return;
    }
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const artifact = await uploadRules(projectId, file);
      setCurrent(artifact);
      if (artifact.content) setRulesText(artifact.content);
      setSaved(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  if (projects.length === 0) {
    return (
      <StepShell slug="plan">
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
    <StepShell slug="plan">
      <div className="mt-4 space-y-4">
        <div>
          <label htmlFor="plan-project" className="block text-sm font-medium text-slate-700">
            Project
          </label>
          <select
            id="plan-project"
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

        <div>
          <label htmlFor="rules-text" className="block text-sm font-medium text-slate-700">
            Transformation rules
          </label>
          <p className="mt-1 text-xs text-slate-500">
            Describe, in plain English, how the raw data should be transformed. The agent turns
            these into reviewable SQL.
          </p>
          <textarea
            id="rules-text"
            value={rulesText}
            onChange={(e) => {
              setRulesText(e.target.value);
              setSaved(false);
            }}
            rows={8}
            placeholder="e.g. Keep only active loans. Compute days past due. Aggregate balance by branch."
            className="mt-2 w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          />
          <div className="mt-2 flex items-center gap-3">
            <button
              type="button"
              onClick={() => void handleSaveText()}
              disabled={saving || rulesText.trim().length === 0}
              className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save rules"}
            </button>
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={saving}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              Upload a rules file
            </button>
            <input
              ref={inputRef}
              type="file"
              accept=".txt,.md,text/plain,text/markdown"
              className="hidden"
              aria-label="Rules file"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleUpload(file);
                e.target.value = "";
              }}
            />
          </div>
        </div>

        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}

        {saved && current && (
          <p role="status" className="text-sm text-slate-700">
            Rules saved.{" "}
            <Link to="/review" className="font-medium text-indigo-600 hover:underline">
              Continue to Review →
            </Link>
          </p>
        )}
      </div>
    </StepShell>
  );
}
