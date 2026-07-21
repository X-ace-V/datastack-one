import type { ChatMessage } from "../store/sessionStore";
import { InlineSteps } from "./InlineSteps";

/**
 * One rendered chat turn (TASKS V2.4/V2.5, PRD FR2, ARCHITECTURE §4). A user turn is a
 * right-aligned bubble carrying the text the user typed; an assistant turn is a left-aligned
 * block of the agent's streamed reply, rendered by {@link InlineSteps} in reading order —
 * streamed text, reasoning, and tool cards (V2.5), plus inline approval pills (V2.6).
 *
 * An assistant turn with no renderable content yet renders nothing rather than an empty bubble.
 */
export interface MessageBubbleProps {
  message: ChatMessage;
}

/** Block kinds InlineSteps renders visibly — an approval-only turn (a paused write) still shows. */
const RENDERABLE_KINDS = new Set(["text", "reasoning", "tool", "approval", "question"]);

export function MessageBubble({ message }: MessageBubbleProps) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end" data-role="user">
        <div className="max-w-[82%] rounded-[1.35rem] rounded-br-md bg-gradient-to-br from-violet-600 to-indigo-600 px-4 py-3 text-sm leading-6 text-white shadow-md shadow-violet-900/10">
          {message.content && <p className="whitespace-pre-wrap">{message.content}</p>}
          {message.attachments && message.attachments.length > 0 && (
            <div className={`flex flex-wrap gap-1.5 ${message.content ? "mt-2" : ""}`}>
              {message.attachments.map((attachment) => (
                <span key={`${attachment.name}:${attachment.kind}`} className="rounded-full bg-white/15 px-2 py-1 text-xs">
                  {attachment.name} · {attachment.kind}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  const hasRenderable = message.blocks.some((b) => RENDERABLE_KINDS.has(b.kind));
  if (!hasRenderable) return null;

  return (
    <div className="flex justify-start gap-3" data-role="assistant">
      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-slate-900 text-white shadow-sm" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" stroke="currentColor" strokeWidth="1.8">
          <path d="M4 7.5 12 3l8 4.5-8 4.5-8-4.5Z" />
          <path d="m4 12 8 4.5 8-4.5" />
        </svg>
      </span>
      <div className="min-w-0 max-w-[88%] flex-1 pt-1 text-[15px] leading-7 text-slate-800">
        <InlineSteps blocks={message.blocks} />
      </div>
    </div>
  );
}
