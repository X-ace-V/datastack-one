import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { StepShell } from "../components/StepShell";
import { ProgressStepper } from "../components/ProgressStepper";
import { ApprovalModal } from "../components/ApprovalModal";
import {
  getRunState,
  listProjects,
  resolveRunApproval,
  startRun,
  subscribeRunEvents,
  type ApprovalAction,
  type Project,
  type Run,
  type RunApprovalRequest,
  type RunEvent,
  type RunStatus,
  type RunStep,
} from "../lib/api";

/**
 * Step 5 — run the pipeline with per-stage approvals (T4.5, FR8/FR9). For the selected project
 * this starts a run (`POST /api/projects/:id/run`), renders the {@link ProgressStepper} of stages,
 * and subscribes to the run's SSE stream to update each stage's status live. When the runner
 * reaches a gated stage it emits an approval request; the {@link ApprovalModal} shows the exact
 * SQL and blocks until the human approves (tool runs once) or rejects (run aborts) — the FR8 gate.
 * On success the Continue-to-Serve link appears. A one-shot `GET /api/runs/:runId` reconcile after
 * subscribing recovers an approval that was requested before the SSE stream connected, so a fast
 * first gate can't deadlock the UI. The wizard does not thread a project id, so it is chosen here.
 */
export function RunPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [run, setRun] = useState<Run | null>(null);
  const [steps, setSteps] = useState<RunStep[]>([]);
  const [status, setStatus] = useState<RunStatus | null>(null);
  const [pending, setPending] = useState<RunApprovalRequest | null>(null);
  const [starting, setStarting] = useState(false);
  const [deciding, setDeciding] = useState(false);
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

  // Apply one streamed run event to local state. Stable (functional updates only) so the SSE
  // subscription effect never needs to resubscribe when component state changes.
  const applyEvent = useCallback((event: RunEvent) => {
    switch (event.kind) {
      case "run.status":
        setStatus(event.status);
        break;
      case "step.status":
        setSteps((prev) =>
          prev.map((step) =>
            step.id === event.stepId
              ? { ...step, status: event.status, detail: event.detail }
              : step,
          ),
        );
        break;
      case "approval.requested":
        setPending(event.request);
        break;
      case "approval.resolved":
        setPending((prev) => (prev && prev.requestID === event.requestID ? null : prev));
        break;
    }
  }, []);

  // Once a run exists, subscribe to its SSE progress stream. A one-shot state fetch reconciles any
  // approval that fired before the stream connected (SSE frames aren't buffered for late viewers).
  useEffect(() => {
    if (!run) return;
    const unsubscribe = subscribeRunEvents(run.id, applyEvent);
    let active = true;
    getRunState(run.id)
      .then((state) => {
        if (!active) return;
        setPending((prev) => prev ?? state.approvals[0] ?? null);
      })
      .catch(() => {
        // A failed reconcile is non-fatal: SSE still drives progress from here.
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [run, applyEvent]);

  async function handleStart() {
    if (!projectId) return;
    setStarting(true);
    setError(null);
    setStatus(null);
    setPending(null);
    setSteps([]);
    setRun(null);
    try {
      const result = await startRun(projectId);
      setRun(result.run);
      setSteps(result.steps);
      setStatus(result.run.status);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  }

  async function handleDecision(action: ApprovalAction) {
    if (!run || !pending) return;
    setDeciding(true);
    setError(null);
    try {
      await resolveRunApproval(run.id, pending.requestID, action);
      // Clear now for responsiveness; the matching approval.resolved event also clears it.
      setPending(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeciding(false);
    }
  }

  if (projects.length === 0) {
    return (
      <StepShell slug="run">
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

  const running = status === "running" || status === "pending";

  return (
    <StepShell slug="run">
      <div className="mt-4 space-y-4">
        <div>
          <label htmlFor="run-project" className="block text-sm font-medium text-slate-700">
            Project
          </label>
          <select
            id="run-project"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            disabled={run !== null && running}
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:bg-slate-100"
          >
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name} — {project.domain}
              </option>
            ))}
          </select>
        </div>

        <div>
          <button
            type="button"
            onClick={handleStart}
            disabled={starting || (run !== null && running)}
            className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {starting ? "Starting…" : run ? "Restart run" : "Start run"}
          </button>
          <p className="mt-2 text-xs text-slate-500">
            The pipeline pauses at every write step and shows the exact SQL for approval before it
            runs.
          </p>
        </div>

        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}

        {run && (
          <section role="region" aria-label="Run progress" className="border-t border-slate-200 pt-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium text-slate-700">Pipeline progress</h3>
              {status && (
                <span
                  role="status"
                  className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700"
                >
                  {status}
                </span>
              )}
            </div>
            <div className="mt-3">
              <ProgressStepper steps={steps} />
            </div>

            {status === "success" && (
              <p role="status" className="mt-4 text-sm text-slate-700">
                Run complete.{" "}
                <Link to="/serve" className="font-medium text-indigo-600 hover:underline">
                  Continue to Serve →
                </Link>
              </p>
            )}
            {status === "rejected" && (
              <p className="mt-4 text-sm text-amber-700">
                Run aborted — a write step was rejected at the approval gate.
              </p>
            )}
            {status === "failed" && (
              <p className="mt-4 text-sm text-red-600">Run failed — see the failed stage above.</p>
            )}
          </section>
        )}
      </div>

      {pending && (
        <ApprovalModal
          request={pending}
          busy={deciding}
          onApprove={() => void handleDecision("approve")}
          onReject={() => void handleDecision("reject")}
        />
      )}
    </StepShell>
  );
}
