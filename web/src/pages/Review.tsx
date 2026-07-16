import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { StepShell } from "../components/StepShell";
import {
  getReviewArtifacts,
  listProjects,
  type Artifact,
  type DqSpec,
  type Plan,
  type Project,
  type Transform,
} from "../lib/api";

/**
 * Step 4 — review every generated artifact before anything executes (T3.5, FR3/FR6/FR7). For
 * the selected project this loads the newest architecture plan, transform SQL, DDL, and DQ
 * spec via `GET /api/projects/:id/artifacts` and renders them read-only. The plan/transform/DQ
 * payloads are stored as JSON in each artifact's `content`; the DDL artifact's content is raw
 * SQL. Approving is the human gate before the run: it is disabled until the plan, transform,
 * and DQ checks all exist (you cannot approve artifacts that were never generated), and only
 * once approved does the Continue-to-Run link appear. The exact-SQL, per-write permission gate
 * (FR8) is separate and happens during the run itself. The wizard does not thread a project id
 * in the URL, so the project is chosen here (defaulting to the most recent).
 */
export function ReviewPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [transform, setTransform] = useState<Transform | null>(null);
  const [dq, setDq] = useState<DqSpec | null>(null);
  const [ddl, setDdl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [approved, setApproved] = useState(false);
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

  // Whenever the selected project changes, load its generated artifacts for review.
  useEffect(() => {
    setApproved(false);
    setPlan(null);
    setTransform(null);
    setDq(null);
    setDdl(null);
    setError(null);
    if (!projectId) return;
    let active = true;
    setLoading(true);
    getReviewArtifacts(projectId)
      .then((artifacts) => {
        if (!active) return;
        setPlan(parseContent<Plan>(artifacts.plan));
        setTransform(parseContent<Transform>(artifacts.transform));
        setDq(parseContent<DqSpec>(artifacts.dq));
        setDdl(artifacts.ddl?.content ?? null);
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [projectId]);

  // The three agent-generated artifacts that must exist before a run can be approved.
  const readyToApprove = plan !== null && transform !== null && dq !== null;

  if (projects.length === 0) {
    return (
      <StepShell slug="review">
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
    <StepShell slug="review">
      <div className="mt-4 space-y-4">
        <div>
          <label htmlFor="review-project" className="block text-sm font-medium text-slate-700">
            Project
          </label>
          <select
            id="review-project"
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

        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}

        {loading && <p className="text-sm text-slate-500">Loading artifacts…</p>}

        {!loading && !readyToApprove && !error && (
          <p className="text-sm text-slate-600">
            Some artifacts have not been generated yet.{" "}
            <Link to="/plan" className="font-medium text-indigo-600 hover:underline">
              Generate the plan, transform SQL, and DQ checks first →
            </Link>
          </p>
        )}

        {plan && (
          <section role="region" aria-label="Plan artifact" className="border-t border-slate-200 pt-4">
            <h3 className="text-sm font-medium text-slate-700">Architecture plan</h3>
            <dl className="mt-2 grid grid-cols-3 gap-2 text-sm">
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
            {plan.summary && <p className="mt-2 text-sm text-slate-700">{plan.summary}</p>}
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-slate-700">
              {plan.steps.map((step, i) => (
                <li key={i}>
                  <span className="font-medium">{step.name}</span> — {step.description}
                </li>
              ))}
            </ol>
          </section>
        )}

        {transform && (
          <section
            role="region"
            aria-label="Transform artifact"
            className="border-t border-slate-200 pt-4"
          >
            <h3 className="text-sm font-medium text-slate-700">Transformation SQL</h3>
            <p className="mt-2 text-xs font-medium text-slate-500">
              Target table: <span className="text-slate-800">marts.{transform.targetTable}</span>
            </p>
            <pre className="mt-1 overflow-x-auto rounded-md bg-slate-900 p-3 font-mono text-xs text-slate-100">
              {transform.sql}
            </pre>
            {transform.assumptions.length > 0 && (
              <div className="mt-2">
                <p className="text-xs font-medium text-slate-500">Assumptions</p>
                <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-slate-700">
                  {transform.assumptions.map((a, i) => (
                    <li key={i}>{a}</li>
                  ))}
                </ul>
              </div>
            )}
            {transform.questions.length > 0 && (
              <div className="mt-2">
                <p className="text-xs font-medium text-slate-500">Clarifying questions</p>
                <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-amber-700">
                  {transform.questions.map((q, i) => (
                    <li key={i}>{q}</li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        )}

        {ddl && (
          <section role="region" aria-label="DDL artifact" className="border-t border-slate-200 pt-4">
            <h3 className="text-sm font-medium text-slate-700">DDL</h3>
            <pre className="mt-2 overflow-x-auto rounded-md bg-slate-900 p-3 font-mono text-xs text-slate-100">
              {ddl}
            </pre>
          </section>
        )}

        {dq && (
          <section
            role="region"
            aria-label="DQ artifact"
            className="border-t border-slate-200 pt-4"
          >
            <h3 className="text-sm font-medium text-slate-700">Data-quality checks</h3>
            <p className="mt-2 text-xs font-medium text-slate-500">
              Target table: <span className="text-slate-800">{dq.targetTable}</span>
            </p>
            <ul className="mt-2 space-y-2 text-sm">
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
          </section>
        )}

        <div className="border-t border-slate-200 pt-4">
          <button
            type="button"
            onClick={() => setApproved(true)}
            disabled={!readyToApprove || approved}
            className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {approved ? "Approved" : "Approve artifacts"}
          </button>
          <p className="mt-2 text-xs text-slate-500">
            Approving confirms you have reviewed every generated artifact. Each write step is
            still gated by its own approval, showing the exact SQL, when the pipeline runs.
          </p>

          {approved && (
            <p role="status" className="mt-2 text-sm text-slate-700">
              Artifacts approved.{" "}
              <Link to="/run" className="font-medium text-indigo-600 hover:underline">
                Continue to Run →
              </Link>
            </p>
          )}
        </div>
      </div>
    </StepShell>
  );
}

/**
 * Parse an artifact's JSON `content` into its structured payload, or `null` when the artifact
 * is absent or its content does not parse. Generation validates the payload before storing, so
 * a parse failure here means the artifact is effectively unavailable for review.
 */
function parseContent<T>(artifact: Artifact | null): T | null {
  if (!artifact?.content) return null;
  try {
    return JSON.parse(artifact.content) as T;
  } catch {
    return null;
  }
}
