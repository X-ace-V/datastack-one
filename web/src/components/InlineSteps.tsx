import { useState } from "react";
import type { InlineBlock } from "../store/sessionStore";
import { ApprovalPill } from "./ApprovalPill";
import { MarkdownText } from "./MarkdownText";
import { ToolCard } from "./ToolCard";

/**
 * The ordered body of an assistant turn (TASKS V2.5/V2.6, PRD FR2/FR10, ARCHITECTURE §4). The store
 * folds the event stream into an ordered list of {@link InlineBlock}s — streamed text, agent
 * reasoning, tool cards, and inline approval pills — and this renders them in exactly that reading
 * order, so a tool card sits where it streamed, reasoning stays before the text it produced, and an
 * approval pill sits next to the write tool it gates. Mirrors Crux's `InlineSteps`.
 */
export interface InlineStepsProps {
  blocks: InlineBlock[];
}

/** Reasoning is verbose and secondary, so it renders as a collapsible "Thinking" section. */
function ReasoningSection({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  if (text.length === 0) return null;
  return (
    <div data-role="reasoning" className="rounded-xl border border-slate-200/80 bg-slate-50/80 px-3 py-2">
      <button
        type="button"
        onClick={() => setExpanded((p) => !p)}
        aria-expanded={expanded}
        className="flex items-center gap-1.5 text-xs font-semibold text-slate-500 transition-colors hover:text-slate-700"
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
    <div className="flex flex-col gap-3">
      {blocks.map((block) => {
        switch (block.kind) {
          case "text":
            return block.text.length === 0 ? null : (
              <MarkdownText key={block.partID} text={block.text} />
            );
          case "reasoning":
            return <ReasoningSection key={block.partID} text={block.text} />;
          case "tool":
            return <ToolCard key={block.callID} block={block} />;
          case "approval":
            return <ApprovalPill key={block.requestID} block={block} />;
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
