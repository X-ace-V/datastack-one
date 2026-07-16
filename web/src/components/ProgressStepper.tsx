import type { RunStep, StepStatus } from "../lib/api";

/**
 * Renders the ordered pipeline stages of a run with each stage's live status (T4.5, FR9).
 * The steps come straight from the backend (`POST /api/projects/:id/run` then SSE updates), so
 * the stepper always reflects the real run — it grows from four stages to the full
 * Extract → Land → Load → Transform → DQ Checks → Publish set automatically as the DQ and Publish
 * stages join `PIPELINE_STAGES`. Each stage shows a human label, a status badge, and the detail
 * line the runner emits (rows landed, rows loaded, the materialized row count, …).
 */

/** Human labels for the known stage machine names; unknown names fall back to a humanized form. */
const STEP_LABELS: Record<string, string> = {
  extract: "Extract",
  land: "Land Parquet",
  load: "Load Warehouse",
  transform: "Transform",
  dq: "DQ Checks",
  publish: "Publish",
};

/** Tailwind classes + accessible text for each step status badge. */
const STATUS_STYLES: Record<StepStatus, { label: string; className: string }> = {
  pending: { label: "Pending", className: "bg-slate-100 text-slate-500" },
  running: { label: "Running", className: "bg-indigo-100 text-indigo-700" },
  success: { label: "Success", className: "bg-emerald-100 text-emerald-700" },
  failed: { label: "Failed", className: "bg-red-100 text-red-700" },
  skipped: { label: "Skipped", className: "bg-amber-100 text-amber-700" },
};

function stepLabel(name: string): string {
  return STEP_LABELS[name] ?? name.charAt(0).toUpperCase() + name.slice(1);
}

export function ProgressStepper({ steps }: { steps: RunStep[] }) {
  const ordered = [...steps].sort((a, b) => a.ordinal - b.ordinal);
  return (
    <ol role="list" aria-label="Pipeline progress" className="space-y-2">
      {ordered.map((step, index) => {
        const status = STATUS_STYLES[step.status];
        return (
          <li
            key={step.id}
            className="flex items-start gap-3 rounded-md border border-slate-200 p-3"
          >
            <span
              aria-hidden="true"
              className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-medium text-slate-600"
            >
              {index + 1}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-medium text-slate-800">{stepLabel(step.name)}</span>
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-medium ${status.className}`}
                >
                  {status.label}
                </span>
              </div>
              {step.detail && (
                <p className="mt-1 truncate text-xs text-slate-500">{step.detail}</p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
