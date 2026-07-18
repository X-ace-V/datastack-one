import { useEffect, useState } from "react";
import { getSessionLineage, type LineageEvent } from "../lib/api";

/**
 * The "audit trail" section of the data panel (TASKS V4.4, PRD FR12) — a session's persisted
 * lineage: the write tool calls it executed, the approvals a human answered, and the DQ results,
 * in order. Unlike the schema/query/endpoint sections (derived from the live chat stream's tool
 * metadata), this reads the **persisted** trail from `GET /api/sessions/:id/lineage`, so it is the
 * durable audit PRD §5 verifies "100% of writes were approved" against — it survives a reopened
 * session and a restart.
 *
 * It refetches whenever `sessionId` changes or `refreshKey` does (the panel bumps `refreshKey` when
 * a turn settles), so a write/approval/check that just landed shows without a manual reload. A
 * read-in-flight is invalidated by the effect's `active` guard so a stale response never overwrites
 * a newer one.
 */

/** Map a lineage status to its badge label + colour. Terminal-good states are green, refusals slate, failures red. */
const STATUS_STYLE: Record<
  NonNullable<LineageEvent["status"]>,
  { label: string; className: string }
> = {
  completed: { label: "Completed", className: "bg-emerald-100 text-emerald-700" },
  approved: { label: "Approved", className: "bg-emerald-100 text-emerald-700" },
  passed: { label: "Passed", className: "bg-emerald-100 text-emerald-700" },
  rejected: { label: "Rejected", className: "bg-slate-200 text-slate-600" },
  error: { label: "Error", className: "bg-red-100 text-red-700" },
  failed: { label: "Failed", className: "bg-red-100 text-red-700" },
};

/** The human label for a lineage kind. */
const KIND_LABEL: Record<LineageEvent["kind"], string> = {
  tool_call: "Tool call",
  approval: "Approval",
  dq_result: "Data-quality check",
};

/** Read a string field from a lineage `detail` payload, or null if absent/not a string. */
function detailString(detail: Record<string, unknown> | null, key: string): string | null {
  const value = detail?.[key];
  return typeof value === "string" ? value : null;
}

/** Read a number field from a lineage `detail` payload, or null if absent/not a number. */
function detailNumber(detail: Record<string, unknown> | null, key: string): number | null {
  const value = detail?.[key];
  return typeof value === "number" ? value : null;
}

/**
 * Build a one-line, human-readable summary of an event's detail. Defensive: `detail` is arbitrary
 * JSON, so every field access is guarded and a missing field simply drops from the summary.
 */
function summarize(event: LineageEvent): string | null {
  const { detail } = event;
  if (event.kind === "dq_result") {
    const results = detail?.results;
    if (Array.isArray(results)) {
      const failed = results.filter(
        (r) => typeof r === "object" && r !== null && (r as { passed?: unknown }).passed === false,
      ).length;
      return `${results.length} check(s), ${failed} failed`;
    }
    return null;
  }
  if (event.status === "error") {
    return detailString(detail, "error");
  }
  if (event.kind === "tool_call") {
    const rows = detailNumber(detail, "rowCount");
    const parts = [
      detailString(detail, "qualifiedTable") ??
        detailString(detail, "endpoint") ??
        detailString(detail, "dataset") ??
        detailString(detail, "source") ??
        detailString(detail, "name"),
      rows !== null ? `${rows.toLocaleString()} rows` : null,
    ].filter((p): p is string => p !== null);
    return parts.length ? parts.join(" · ") : null;
  }
  // approval: the reviewed summary, when the write route attached one.
  const metadata = detail?.metadata;
  if (metadata && typeof metadata === "object") {
    const summary = (metadata as { summary?: unknown }).summary;
    if (typeof summary === "string") return summary;
  }
  return null;
}

export function LineageView({
  sessionId,
  refreshKey,
}: {
  sessionId: string;
  refreshKey?: string | number;
}) {
  const [lineage, setLineage] = useState<LineageEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setError(null);
    getSessionLineage(sessionId)
      .then((events) => {
        if (active) setLineage(events);
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      active = false;
    };
  }, [sessionId, refreshKey]);

  if (error) {
    return (
      <p role="alert" className="text-xs text-red-600">
        {error}
      </p>
    );
  }

  if (lineage.length === 0) {
    return (
      <p className="text-xs text-slate-400">
        Write tool calls, approvals, and data-quality checks appear here.
      </p>
    );
  }

  return (
    <ol className="space-y-2">
      {lineage.map((event) => {
        const style = event.status ? STATUS_STYLE[event.status] : null;
        const summary = summarize(event);
        return (
          <li
            key={event.id}
            data-kind={event.kind}
            data-status={event.status ?? ""}
            className="rounded-md border border-slate-200 p-2.5 text-xs"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2 truncate">
                <span className="text-slate-400">{KIND_LABEL[event.kind]}</span>
                {event.tool && (
                  <span className="truncate font-mono font-medium text-slate-800">
                    {event.tool}
                  </span>
                )}
              </span>
              {style && (
                <span
                  className={`shrink-0 rounded px-1.5 py-0.5 font-medium ${style.className}`}
                >
                  {style.label}
                </span>
              )}
            </div>
            {summary && <p className="mt-1 truncate text-slate-500">{summary}</p>}
          </li>
        );
      })}
    </ol>
  );
}
