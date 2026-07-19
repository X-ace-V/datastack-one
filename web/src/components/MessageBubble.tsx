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
const RENDERABLE_KINDS = new Set(["text", "reasoning", "tool", "approval"]);

export function MessageBubble({ message }: MessageBubbleProps) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end" data-role="user">
        <div className="max-w-[80%] rounded-2xl bg-indigo-600 px-4 py-2 text-sm text-white">
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
    <div className="flex justify-start" data-role="assistant">
      <div className="max-w-[80%] text-sm leading-relaxed text-slate-800">
        <InlineSteps blocks={message.blocks} />
      </div>
    </div>
  );
}
