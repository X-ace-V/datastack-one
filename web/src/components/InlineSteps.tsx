import { useState } from "react";
import type { InlineBlock } from "../store/sessionStore";
import { ToolCard } from "./ToolCard";

/**
 * The ordered body of an assistant turn (TASKS V2.5, PRD FR2, ARCHITECTURE §4). The store folds
 * the event stream into an ordered list of {@link InlineBlock}s — streamed text, agent reasoning,
 * tool cards, and (V2.6) inline approval pills — and this renders them in exactly that reading
 * order, so a tool card sits where it streamed and reasoning stays before the text it produced.
 * Mirrors Crux's `InlineSteps`, sized down to this app's block union.
 *
 * `approval` blocks are the seam for V2.6 (`ApprovalPill`); until then they render nothing.
 */
export interface InlineStepsProps {
  blocks: InlineBlock[];
}

/** Reasoning is verbose and secondary, so it renders as a collapsible "Thinking" section. */
function ReasoningSection({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  if (text.length === 0) return null;
  return (
    <div data-role="reasoning">
      <button
        type="button"
        onClick={() => setExpanded((p) => !p)}
        aria-expanded={expanded}
        className="flex items-center gap-1.5 text-xs font-medium text-slate-400 hover:text-slate-600"
      >
        Thinking
        <svg
          className={`h-3 w-3 transition-transform ${expanded ? "rotate-180" : ""}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {expanded && (
        <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-slate-400">{text}</p>
      )}
    </div>
  );
}

export function InlineSteps({ blocks }: InlineStepsProps) {
  return (
    <div className="flex flex-col gap-2">
      {blocks.map((block) => {
        switch (block.kind) {
          case "text":
            return block.text.length === 0 ? null : (
              <p key={block.partID} className="whitespace-pre-wrap">
                {block.text}
              </p>
            );
          case "reasoning":
            return <ReasoningSection key={block.partID} text={block.text} />;
          case "tool":
            return <ToolCard key={block.callID} block={block} />;
          case "approval":
            // V2.6 seam — ApprovalPill renders these; nothing to show yet.
            return null;
          default: {
            const _never: never = block;
            void _never;
            return null;
          }
        }
      })}
    </div>
  );
}
