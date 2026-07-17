import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ProgressStepper } from "../components/ProgressStepper";
import {
  getRunLineage,
  type RunLineage,
  type RunStatus,
  type ToolCallStatus,
} from "../lib/api";

/**
 * Run detail view (T5.5, FR12) — the per-run lineage record at `/runs/:runId`. Renders what a run
 * actually did, after the fact: its ordered steps, every tool call it executed (with the args it
 * ran with and what came back), every approval a human decided, and every DQ check outcome. Reads
 * `GET /api/runs/:runId/lineage`; unlike the Run page it opens no SSE stream, because this is the
 * audit record of a finished run rather than a live one.
 *
 * Honesty rules this view holds to: an empty record says so explicitly instead of rendering an
 * empty table, and tool/approval args that were not recorded say "not recorded" rather than
 * implying the tool ran with no arguments.
 */

/** Tailwind classes + accessible text for each run status badge. */
const RUN_STATUS_STYLES: Record<RunStatus, { label: string; className: string }> = {
  pending: { label: "Pending", className: "bg-slate-100 text-slate-600" },
  running: { label: "Running", className: "bg-indigo-100 text-indigo-700" },
  success: { label: "Success", className: "bg-emerald-100 text-emerald-700" },
  failed: { label: "Failed", className: "bg-red-100 text-red-700" },
  rejected: { label: "Rejected", className: "bg-amber-100 text-amber-700" },
};

/** Tailwind classes + accessible text for each tool-call status badge. */
const TOOL_STATUS_STYLES: Record<ToolCallStatus, { label: string; className: string }> = {
  running: { label: "Running", className: "bg-indigo-100 text-indigo-700" },
  success: { label: "Success", className: "bg-emerald-100 text-emerald-700" },
  failed: { label: "Failed", className: "bg-red-100 text-red-700" },
};

/**
 * Render recorded args as readable JSON. `null` means the args were not recorded (a NULL column or
 * a corrupted row) — it is NOT the same as an empty arg map, so it must not render as `{}`.
 */
function ArgsBlock({ args }: { args: Record<string, unknown> | null }) {
  if (args === null) {
    return <p className="mt-1 text-xs italic text-slate-400">args not recorded</p>;
  }
  return (
    <pre className="mt-1 overflow-x-auto rounded bg-slate-50 p-2 text-xs text-slate-600">
      {JSON.stringify(args, null, 2)}
    </pre>
  );
}

/** A titled lineage section that states plainly when it recorded nothing. */
function Section({
  title,
  count,
  empty,
  children,
}: {
  title: string;
  count: number;
  empty: string;
  children: React.ReactNode;
}) {
  return (
    <section
      role="region"
      aria-label={title}
      className="border-t border-slate-200 pt-4"
    >
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-medium text-slate-700">{title}</h2>
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
          {count}
        </span>
      </div>
      {count === 0 ? (
        <p className="mt-2 text-sm text-slate-500">{empty}</p>
      ) : (
        <div className="mt-3">{children}</div>
      )}
    </section>
  );
}

export function RunDetailPage() {
  const { runId } = useParams<{ runId: string }>();
  const [lineage, setLineage] = useState<RunLineage | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!runId) return;
    let active = true;
    setLineage(null);
    setError(null);
    getRunLineage(runId)
      .then((result) => {
        if (active) setLineage(result);
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      active = false;
    };
  }, [runId]);

  if (error) {
    return (
      <section className="space-y-2">
        <h1 className="text-2xl font-semibold text-slate-900">Run detail</h1>
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
        <Link to="/run" className="text-sm font-medium text-indigo-600 hover:underline">
          ← Back to Run
        </Link>
      </section>
    );
  }

  if (!lineage) {
    return (
      <section className="space-y-2">
        <h1 className="text-2xl font-semibold text-slate-900">Run detail</h1>
        <p className="text-sm text-slate-500">Loading run lineage…</p>
      </section>
    );
  }

  const { run, steps, toolCalls, approvals, dqResults } = lineage;
  const runStatus = RUN_STATUS_STYLES[run.status];
  const failedChecks = dqResults.filter((r) => !r.passed);

  return (
    <section className="space-y-2">
      <h1 className="text-2xl font-semibold text-slate-900">Run detail</h1>
      <p className="text-slate-600">
        Everything this run recorded: its stages, the tools it executed, the approvals a human gave,
        and every data-quality result.
      </p>

      <div className="mt-4 space-y-4">
        <section
          role="region"
          aria-label="Run summary"
          className="rounded-md border border-slate-200 p-3"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs text-slate-500">{run.id}</span>
            <span
              role="status"
              className={`rounded-full px-2 py-0.5 text-xs font-medium ${runStatus.className}`}
            >
              {runStatus.label}
            </span>
          </div>
          <dl className="mt-2 grid grid-cols-2 gap-2 text-xs text-slate-600 sm:grid-cols-3">
            <div>
              <dt className="text-slate-400">Model</dt>
              <dd>{run.model ?? "runtime default"}</dd>
            </div>
            <div>
              <dt className="text-slate-400">Started</dt>
              <dd>{run.createdAt}</dd>
            </div>
            <div>
              <dt className="text-slate-400">Updated</dt>
              <dd>{run.updatedAt}</dd>
            </div>
          </dl>
        </section>

        <Section title="Steps" count={steps.length} empty="This run recorded no steps.">
          <ProgressStepper steps={steps} />
        </Section>

        <Section
          title="Tool calls"
          count={toolCalls.length}
          empty="This run executed no tools."
        >
          <ol role="list" className="space-y-2">
            {toolCalls.map((call) => {
              const status = TOOL_STATUS_STYLES[call.status];
              return (
                <li key={call.id} className="rounded-md border border-slate-200 p-3">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm font-medium text-slate-800">
                      {call.tool}
                    </span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${status.className}`}
                    >
                      {status.label}
                    </span>
                  </div>
                  {call.result && <p className="mt-1 text-xs text-slate-600">{call.result}</p>}
                  {call.error && (
                    <p className="mt-1 text-xs text-red-600">{call.error}</p>
                  )}
                  <ArgsBlock args={call.args} />
                </li>
              );
            })}
          </ol>
        </Section>

        <Section
          title="Approvals"
          count={approvals.length}
          empty="No approval was decided for this run."
        >
          <ol role="list" className="space-y-2">
            {approvals.map((approval) => (
              <li key={approval.id} className="rounded-md border border-slate-200 p-3">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm font-medium text-slate-800">
                    {approval.tool}
                  </span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                      approval.action === "approve"
                        ? "bg-emerald-100 text-emerald-700"
                        : "bg-amber-100 text-amber-700"
                    }`}
                  >
                    {approval.action === "approve" ? "Approved" : "Rejected"}
                  </span>
                </div>
                <p className="mt-1 text-xs text-slate-500">
                  Decided {approval.decidedAt ?? "—"}
                </p>
                <ArgsBlock args={approval.args} />
              </li>
            ))}
          </ol>
        </Section>

        <Section
          title="Data quality"
          count={dqResults.length}
          empty="This run recorded no data-quality results."
        >
          <>
            {failedChecks.length > 0 && (
              <p className="mb-2 text-xs font-medium text-red-600">
                {failedChecks.length} of {dqResults.length} checks failed — publish was blocked.
              </p>
            )}
            <ol role="list" className="space-y-2">
              {dqResults.map((result) => (
                <li key={result.id} className="rounded-md border border-slate-200 p-3">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-slate-800">
                      {result.checkName}
                    </span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                        result.passed
                          ? "bg-emerald-100 text-emerald-700"
                          : "bg-red-100 text-red-700"
                      }`}
                    >
                      {result.passed ? "Passed" : "Failed"}
                    </span>
                  </div>
                  {result.detail && (
                    <p className="mt-1 text-xs text-slate-600">{result.detail}</p>
                  )}
                </li>
              ))}
            </ol>
          </>
        </Section>

        <p className="pt-2">
          <Link to="/run" className="text-sm font-medium text-indigo-600 hover:underline">
            ← Back to Run
          </Link>
        </p>
      </div>
    </section>
  );
}
