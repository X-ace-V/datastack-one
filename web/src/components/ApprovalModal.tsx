import type { RunApprovalRequest } from "../lib/api";

/**
 * The FR8 approval gate, rendered as a modal dialog (T4.5). When the runner reaches a gated stage
 * it emits an `approval.requested` event; the Run page shows this modal, which displays the exact
 * SQL/DDL the tool will run (the transform) — or a human-readable summary plus the tool args when
 * the statement is not a fixed string — and blocks until the human approves or rejects. Approve
 * runs the tool once; reject aborts the run. Nothing executes without an explicit click here, so
 * this is the visible enforcement point for "100% human approval before execution".
 */
export function ApprovalModal({
  request,
  busy,
  onApprove,
  onReject,
}: {
  request: RunApprovalRequest;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  // Args minus the sql (shown separately) — the remaining tool inputs for full transparency.
  const argEntries = Object.entries(request.args);

  return (
    <div
      className="fixed inset-0 z-10 flex items-center justify-center bg-slate-900/40 p-4"
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="approval-title"
        className="w-full max-w-lg rounded-lg bg-white p-5 shadow-xl"
      >
        <h2 id="approval-title" className="text-lg font-semibold text-slate-900">
          Approval required
        </h2>
        <p className="mt-1 text-sm text-slate-600">{request.summary}</p>

        <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
          <div>
            <dt className="text-xs font-medium text-slate-500">Tool</dt>
            <dd className="font-mono text-slate-800">{request.tool}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-slate-500">Stage</dt>
            <dd className="text-slate-800">{request.stepName}</dd>
          </div>
        </dl>

        {request.sql && (
          <div className="mt-3">
            <p className="text-xs font-medium text-slate-500">SQL to execute</p>
            <pre className="mt-1 max-h-60 overflow-auto rounded-md bg-slate-900 p-3 font-mono text-xs text-slate-100">
              {request.sql}
            </pre>
          </div>
        )}

        {argEntries.length > 0 && (
          <div className="mt-3">
            <p className="text-xs font-medium text-slate-500">Arguments</p>
            <dl className="mt-1 space-y-1 text-xs">
              {argEntries.map(([key, value]) => (
                <div key={key} className="flex gap-2">
                  <dt className="font-mono text-slate-500">{key}</dt>
                  <dd className="break-all font-mono text-slate-700">
                    {typeof value === "string" ? value : JSON.stringify(value)}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onReject}
            disabled={busy}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            Reject
          </button>
          <button
            type="button"
            onClick={onApprove}
            disabled={busy}
            className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            Approve
          </button>
        </div>
      </div>
    </div>
  );
}
