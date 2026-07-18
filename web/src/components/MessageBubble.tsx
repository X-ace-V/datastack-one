import type { ChatMessage, InlineBlock } from "../store/sessionStore";

/**
 * One rendered chat turn (TASKS V2.4, PRD FR2, ARCHITECTURE §4). A user turn is a right-aligned
 * bubble carrying the text the user typed; an assistant turn is a left-aligned block of the
 * agent's streamed reply.
 *
 * This task renders the assistant's **streamed text** (the FR2 answer). Its turn also carries
 * reasoning, tool cards, and inline approval pills in reading order — those are rendered by
 * `InlineSteps`/`ToolCard` (V2.5) and `ApprovalPill` (V2.6), which replace the text-only body
 * here. Until then a text-less assistant turn (only a tool call, say) renders nothing rather than
 * an empty bubble.
 */
export interface MessageBubbleProps {
  message: ChatMessage;
}

/** Narrow to the text blocks of an assistant turn (the only kind V2.4 renders). */
type TextBlock = Extract<InlineBlock, { kind: "text" }>;

export function MessageBubble({ message }: MessageBubbleProps) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end" data-role="user">
        <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl bg-indigo-600 px-4 py-2 text-sm text-white">
          {message.content}
        </div>
      </div>
    );
  }

  const textBlocks = message.blocks.filter(
    (b): b is TextBlock => b.kind === "text",
  );
  if (textBlocks.length === 0) return null;

  return (
    <div className="flex justify-start" data-role="assistant">
      <div className="max-w-[80%] text-sm leading-relaxed text-slate-800">
        {textBlocks.map((b) => (
          <p key={b.partID} className="whitespace-pre-wrap">
            {b.text}
          </p>
        ))}
      </div>
    </div>
  );
}
