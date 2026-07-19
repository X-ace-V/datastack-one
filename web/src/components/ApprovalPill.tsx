import { useState } from "react";
import { answerApproval, type ApprovalAction } from "../lib/api";
import type { ApprovalStatus, InlineBlock } from "../store/sessionStore";

/**
 * One inline approval pill in an assistant turn (TASKS V2.6, PRD FR10, ARCHITECTURE §6). A write
 * tool (`land_parquet`/`load_warehouse`/`run_transform`/`publish_serving`) pauses the turn with a
 * `permission.asked`; the store folds it into an ordered `approval` block sitting next to the tool
 * call it gates. This renders that block: the gated tool, the exact SQL/DDL a human must review,
 * and Allow/Deny buttons that relay the decision to `POST /api/approvals/:requestID`.
 *
 * Approve runs the gated call once; reject aborts it. Nothing writes until a human answers here —
 * this pill is the FR10 gate's UI. On a successful answer the buttons clear (optimistically, then
 * confirmed by the `approval_resolved` event that flips the block's status); a failed answer keeps
 * the buttons so the human can retry.
 */
export type ApprovalBlock = Extract<InlineBlock, { kind: "approval" }>;

export interface ApprovalPillProps {
  block: ApprovalBlock;
}

/** Metadata keys that carry the SQL/DDL the human reviews, in order of preference. */
const SQL_KEYS = ["sql", "ddl", "query", "statement", "command"] as const;

/**
 * Pull the human-reviewable SQL/DDL out of a permission's metadata. Write tools carry it under a
 * `sql`/`ddl`/… key; a bash surface carries a `command`, or its command in `patterns`. Falls back
 * to the pretty-printed metadata so a human always sees exactly what the tool would run — never an
 * empty pill hiding the payload. Returns "" only when there is genuinely nothing to show.
 */
function reviewText(block: ApprovalBlock): string {
  for (const key of SQL_KEYS) {
    const value = block.metadata[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  if (block.patterns && block.patterns.length > 0) return block.patterns.join("\n");
  if (Object.keys(block.metadata).length === 0) return "";
  try {
    return JSON.stringify(block.metadata, null, 2);
  } catch {
    return String(block.metadata);
  }
}

/** Visual treatment + human label per resolved approval status (mirrors ToolCard's badges). */
const STATUS_META: Record<ApprovalStatus, { label: string; className: string }> = {
  pending: { label: "Needs approval", className: "bg-amber-100 text-amber-700" },
  approved: { label: "Approved", className: "bg-emerald-100 text-emerald-700" },
  rejected: { label: "Denied", className: "bg-red-100 text-red-700" },
};

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function ApprovalPill({ block }: ApprovalPillProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set the moment an answer POST succeeds, so the buttons clear immediately even before the
  // `approval_resolved` event arrives. The block's own status (from the store) wins once it lands.
  const [optimistic, setOptimistic] = useState<ApprovalStatus | null>(null);

  const status: ApprovalStatus =
    block.status !== "pending" ? block.status : optimistic ?? "pending";
  const badge = STATUS_META[status];
  const sql = reviewText(block);

  const decide = async (action: ApprovalAction) => {
    setBusy(true);
    setError(null);
    try {
      await answerApproval(block.requestID, action);
      setOptimistic(action === "approve" ? "approved" : "rejected");
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="overflow-hidden rounded-xl border border-amber-200 bg-amber-50/70 text-sm shadow-sm"
      data-role="approval"
      data-approval-type={block.approvalType}
      data-status={status}
    >
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        <span className="flex h-6 w-6 items-center justify-center rounded-md bg-amber-100 text-amber-700" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" className="h-3.5 w-3.5" stroke="currentColor" strokeWidth="1.9"><path d="M12 3 4.5 6v5.5c0 4.5 3.2 7.7 7.5 9.5 4.3-1.8 7.5-5 7.5-9.5V6L12 3Z" /><path d="m9 12 2 2 4-4" /></svg></span>
        <span className="font-mono text-xs font-semibold text-slate-700">{block.approvalType}</span>
        <span
          className={`ml-auto shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${badge.className}`}
          data-testid="approval-status"
        >
          {badge.label}
        </span>
      </div>

      {sql.length > 0 && (
        <pre
          data-testid="approval-sql"
          className="mx-3 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-amber-100 bg-white px-3 py-2 font-mono text-[11px] leading-5 text-slate-600"
        >
          {sql}
        </pre>
      )}

      {status === "pending" ? (
        <div className="flex items-center gap-2 px-3 py-3">
          <button
            type="button"
            onClick={() => void decide("approve")}
            disabled={busy}
            className="rounded-lg bg-slate-950 px-3.5 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-700 disabled:opacity-50"
          >
            Allow
          </button>
          <button
            type="button"
            onClick={() => void decide("reject")}
            disabled={busy}
            className="rounded-lg border border-slate-300 bg-white px-3.5 py-1.5 text-xs font-semibold text-slate-600 transition hover:border-red-200 hover:bg-red-50 hover:text-red-700 disabled:opacity-50"
          >
            Deny
          </button>
          {busy && <span className="text-xs text-slate-400">Submitting…</span>}
          {error && (
            <span role="alert" className="text-xs text-red-600">
              {error}
            </span>
          )}
        </div>
      ) : (
        <p className="px-3 pb-2 text-xs text-slate-400">
          {status === "approved" ? "Approved — the tool ran." : "Denied — the tool did not run."}
        </p>
      )}
    </div>
  );
}
