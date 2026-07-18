import { useState } from "react";
import type { InlineBlock, ToolStatus } from "../store/sessionStore";

/**
 * One tool-call card in an assistant turn (TASKS V2.5, PRD FR2, ARCHITECTURE §4). Renders the
 * tool name + a one-line detail + a status badge in the collapsed header, and expands to show
 * the exact arguments (input) and result (output / error) the agent produced. Mirrors Crux's
 * `ToolCard`, sized down to this app's normalized tool event (no screenshots/subagents).
 *
 * The card is expandable only when there is something to expand (args, output, or an error);
 * a bare pending call with no input renders as a static header.
 */
export type ToolBlock = Extract<InlineBlock, { kind: "tool" }>;

export interface ToolCardProps {
  block: ToolBlock;
}

/** Visual treatment + human label per OpenCode tool status (server/core/events.ts). */
const STATUS_META: Record<ToolStatus, { label: string; className: string }> = {
  pending: { label: "Pending", className: "bg-slate-100 text-slate-500" },
  running: { label: "Running", className: "bg-amber-100 text-amber-700" },
  completed: { label: "Done", className: "bg-emerald-100 text-emerald-700" },
  error: { label: "Error", className: "bg-red-100 text-red-700" },
};

/** Pretty-print the tool arguments; falls back to a plain string if they can't be serialized. */
function formatInput(input: Record<string, unknown> | undefined): string {
  if (!input || Object.keys(input).length === 0) return "";
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

export function ToolCard({ block }: ToolCardProps) {
  const [expanded, setExpanded] = useState(false);

  const status = STATUS_META[block.status];
  const args = formatInput(block.input);
  const hasArgs = args.length > 0;
  const hasOutput = typeof block.output === "string" && block.output.length > 0;
  const hasError = typeof block.error === "string" && block.error.length > 0;
  const expandable = hasArgs || hasOutput || hasError;

  return (
    <div
      className="rounded-lg border border-slate-200 bg-white text-sm"
      data-role="tool"
      data-tool={block.tool}
      data-status={block.status}
    >
      <button
        type="button"
        onClick={expandable ? () => setExpanded((p) => !p) : undefined}
        disabled={!expandable}
        aria-expanded={expandable ? expanded : undefined}
        className={`flex w-full items-center gap-2 px-3 py-2 text-left ${
          expandable ? "cursor-pointer hover:bg-slate-50" : "cursor-default"
        }`}
      >
        <span className="font-mono text-xs font-medium text-slate-700">{block.tool}</span>
        {block.title && (
          <span className="min-w-0 flex-1 truncate text-xs text-slate-400">{block.title}</span>
        )}
        <span
          className={`ml-auto shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${status.className}`}
          data-testid="tool-status"
        >
          {status.label}
        </span>
        {expandable && (
          <svg
            className={`h-3 w-3 shrink-0 text-slate-400 transition-transform ${
              expanded ? "rotate-180" : ""
            }`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
            aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        )}
      </button>

      {expanded && expandable && (
        <div className="space-y-2 border-t border-slate-100 px-3 py-2">
          {hasArgs && (
            <div>
              <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-slate-400">
                Arguments
              </div>
              <pre
                data-testid="tool-args"
                className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-slate-50 px-2 py-1 font-mono text-[11px] text-slate-600"
              >
                {args}
              </pre>
            </div>
          )}
          {hasOutput && (
            <div>
              <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-slate-400">
                Result
              </div>
              <pre
                data-testid="tool-result"
                className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-slate-50 px-2 py-1 font-mono text-[11px] text-slate-600"
              >
                {block.output}
              </pre>
            </div>
          )}
          {hasError && (
            <div>
              <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-red-400">
                Error
              </div>
              <pre
                data-testid="tool-error"
                className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-red-50 px-2 py-1 font-mono text-[11px] text-red-600"
              >
                {block.error}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
