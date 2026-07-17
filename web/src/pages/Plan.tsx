import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { StepShell } from "../components/StepShell";
import { ModelPicker } from "../components/ModelPicker";
import { useModelSelection } from "../lib/model-selection";
import {
  generateDq,
  generatePlan,
  generateTransform,
  getRules,
  listProjects,
  saveRules,
  uploadRules,
  type Artifact,
  type DqSpec,
  type Plan,
  type Project,
  type Transform,
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
  const [plan, setPlan] = useState<Plan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [transform, setTransform] = useState<Transform | null>(null);
  const [transforming, setTransforming] = useState(false);
  const [dq, setDq] = useState<DqSpec | null>(null);
  const [generatingDq, setGeneratingDq] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  /**
   * The model every generation stage below runs on (FR11), persisted so the Run step records the
   * same choice on the run. Null means no explicit choice — the request omits the override and the
   * backend applies its configured default, so the free default lives in one place.
   */
  const [model, selectModel] = useModelSelection();
  /**
   * Token for the rules load currently in flight. A save/upload supersedes it: the artifact the
   * user just wrote is newer than whatever the initial `GET /rules` returns, so once a write starts
   * the pending read must not land — otherwise its (older, possibly null) result clobbers the
   * artifact and the "Rules saved" confirmation vanishes.
   */
  const rulesLoad = useRef({ active: false });

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
    setPlan(null);
    setTransform(null);
    setDq(null);
    if (!projectId) return;
    // Tracked on a ref as well as in the closure so a save/upload can supersede this read the
    // moment it starts, not only when the project changes or the page unmounts.
    const load = { active: true };
    rulesLoad.current = load;
    getRules(projectId)
      .then((rules) => {
        if (!load.active) return;
        setCurrent(rules);
        if (rules?.content) setRulesText(rules.content);
      })
      .catch((err: unknown) => {
        if (load.active) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      load.active = false;
    };
  }, [projectId]);

  async function handleSaveText() {
    if (!projectId) {
      setError("Select a project first.");
      return;
    }
    // This write is newer than any rules read still in flight; drop that read's result.
    rulesLoad.current.active = false;
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
    // This write is newer than any rules read still in flight; drop that read's result.
    rulesLoad.current.active = false;
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

  async function handleGeneratePlan() {
    if (!projectId) {
      setError("Select a project first.");
      return;
    }
    setPlanning(true);
    setError(null);
    setPlan(null);
    try {
      const result = await generatePlan(projectId, model ? { model } : {});
      setPlan(result.plan);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPlanning(false);
    }
  }

  async function handleGenerateTransform() {
    if (!projectId) {
      setError("Select a project first.");
      return;
    }
    setTransforming(true);
    setError(null);
    setTransform(null);
    try {
      const result = await generateTransform(projectId, model ? { model } : {});
      setTransform(result.transform);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTransforming(false);
    }
  }

  async function handleGenerateDq() {
    if (!projectId) {
      setError("Select a project first.");
      return;
    }
    setGeneratingDq(true);
    setError(null);
    setDq(null);
    try {
      const result = await generateDq(projectId, model ? { model } : {});
      setDq(result.dq);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setGeneratingDq(false);
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

        <ModelPicker
          value={model}
          onChange={selectModel}
          disabled={planning || transforming || generatingDq}
        />

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

        <div className="border-t border-slate-200 pt-4">
          <h3 className="text-sm font-medium text-slate-700">Architecture plan</h3>
          <p className="mt-1 text-xs text-slate-500">
            The agent profiles your source and drafts an ELT plan for DuckDB — execution
            pattern, partitioning and the ordered pipeline steps — for you to review.
          </p>
          <button
            type="button"
            onClick={() => void handleGeneratePlan()}
            disabled={planning || !projectId}
            className="mt-2 rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {planning ? "Generating…" : "Generate architecture plan"}
          </button>

          {plan && (
            <div role="region" aria-label="Generated plan" className="mt-4 space-y-3">
              <dl className="grid grid-cols-3 gap-2 text-sm">
                <div>
                  <dt className="text-xs font-medium text-slate-500">Pattern</dt>
                  <dd className="text-slate-800">{plan.executionPattern}</dd>
                </div>
                <div>
                  <dt className="text-xs font-medium text-slate-500">Warehouse</dt>
                  <dd className="text-slate-800">{plan.warehouse}</dd>
                </div>
                <div>
                  <dt className="text-xs font-medium text-slate-500">Partitioning</dt>
                  <dd className="text-slate-800">{plan.partitioning}</dd>
                </div>
              </dl>
              {plan.summary && <p className="text-sm text-slate-700">{plan.summary}</p>}
              <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-700">
                {plan.steps.map((step, i) => (
                  <li key={i}>
                    <span className="font-medium">{step.name}</span> — {step.description}
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>

        <div className="border-t border-slate-200 pt-4">
          <h3 className="text-sm font-medium text-slate-700">Transformation SQL</h3>
          <p className="mt-1 text-xs text-slate-500">
            The agent turns your rules into reviewable DuckDB SQL, surfacing the assumptions it
            made and any clarifying questions. Nothing runs yet — you approve it first.
          </p>
          <button
            type="button"
            onClick={() => void handleGenerateTransform()}
            disabled={transforming || !projectId}
            className="mt-2 rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {transforming ? "Generating…" : "Generate transform SQL"}
          </button>

          {transform && (
            <div role="region" aria-label="Generated transform" className="mt-4 space-y-3">
              <div>
                <p className="text-xs font-medium text-slate-500">
                  Target table: <span className="text-slate-800">marts.{transform.targetTable}</span>
                </p>
                <pre className="mt-1 overflow-x-auto rounded-md bg-slate-900 p-3 font-mono text-xs text-slate-100">
                  {transform.sql}
                </pre>
              </div>
              {transform.assumptions.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-slate-500">Assumptions</p>
                  <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-slate-700">
                    {transform.assumptions.map((a, i) => (
                      <li key={i}>{a}</li>
                    ))}
                  </ul>
                </div>
              )}
              {transform.questions.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-slate-500">Clarifying questions</p>
                  <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-amber-700">
                    {transform.questions.map((q, i) => (
                      <li key={i}>{q}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="border-t border-slate-200 pt-4">
          <h3 className="text-sm font-medium text-slate-700">Data-quality checks</h3>
          <p className="mt-1 text-xs text-slate-500">
            The agent proposes at least three checks — row count, not-null, schema and freshness —
            to run against the loaded source before publishing. Any failing check blocks publish.
          </p>
          <button
            type="button"
            onClick={() => void handleGenerateDq()}
            disabled={generatingDq || !projectId}
            className="mt-2 rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {generatingDq ? "Generating…" : "Generate DQ checks"}
          </button>

          {dq && (
            <div role="region" aria-label="Generated DQ checks" className="mt-4 space-y-3">
              <p className="text-xs font-medium text-slate-500">
                Target table: <span className="text-slate-800">{dq.targetTable}</span>
              </p>
              <ul className="space-y-2 text-sm">
                {dq.checks.map((check, i) => (
                  <li key={i} className="rounded-md border border-slate-200 p-2">
                    <div className="flex items-center gap-2">
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-700">
                        {check.type}
                      </span>
                      <span className="font-medium text-slate-800">{check.name}</span>
                      {check.column && (
                        <span className="text-xs text-slate-500">on {check.column}</span>
                      )}
                    </div>
                    <p className="mt-1 text-slate-700">{check.description}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </StepShell>
  );
}
