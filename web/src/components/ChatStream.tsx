import { useEffect, useRef } from "react";
import type { ChatMessage } from "../store/sessionStore";
import { MessageBubble } from "./MessageBubble";

/**
 * The scrolling transcript of the active session (TASKS V2.4, PRD FR2, ARCHITECTURE §4). It maps
 * the store's ordered messages to {@link MessageBubble}s, shows a working indicator while a turn
 * is in flight, surfaces the last turn error, and auto-scrolls to the tail as new content streams
 * in. Sized down from Crux's `ChatStream` — no pin-scroll choreography, just follow-the-bottom.
 */
export interface ChatStreamProps {
  /** The active session's ordered transcript (user turns + assistant turns). */
  messages: ChatMessage[];
  /** True while a turn is streaming — drives the "Working…" indicator. */
  isWorking: boolean;
  /** The last turn failure, or null. */
  error: string | null;
}

export function ChatStream({ messages, isWorking, error }: ChatStreamProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  // Follow the tail as text streams in and turns arrive. Guarded because jsdom (and older
  // runtimes) may not implement scrollIntoView.
  useEffect(() => {
    const el = bottomRef.current;
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, isWorking, error]);

  const isEmpty = messages.length === 0 && !isWorking && !error;

  return (
    <div className="flex-1 overflow-y-auto px-6 py-4">
      <div className="mx-auto flex max-w-2xl flex-col gap-4">
        {isEmpty ? (
          <p className="pt-8 text-center text-sm text-slate-400">
            Ask the agent to profile, query, or build with your data.
          </p>
        ) : (
          messages.map((m) => <MessageBubble key={m.id} message={m} />)
        )}

        {isWorking && (
          <div role="status" aria-label="Agent working" className="flex justify-start">
            <div className="rounded-2xl bg-slate-100 px-4 py-2 text-sm text-slate-400">
              Working…
            </div>
          </div>
        )}

        {error && (
          <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-600">
            {error}
          </p>
        )}

        <div ref={bottomRef} />
      </div>
    </div>
  );
}
