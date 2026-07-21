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
  const waitingForInput = messages.some((message) =>
    message.role === "assistant" &&
    message.blocks.some((block) => block.kind === "question" && block.status === "pending"),
  );

  return (
    <div className="chat-scroll flex-1 overflow-y-auto px-5 py-7 sm:px-8">
      <div className="mx-auto flex max-w-3xl flex-col gap-6">
        {isEmpty ? (
          <div className="flex min-h-[45vh] flex-col items-center justify-center text-center">
            <span className="flex h-14 w-14 items-center justify-center rounded-2xl border border-violet-100 bg-white text-violet-600 shadow-lg shadow-slate-900/5" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" className="h-6 w-6" stroke="currentColor" strokeWidth="1.7">
                <path d="M4 6h16M4 12h10M4 18h7" />
                <path d="m17 15 3 3-3 3" />
              </svg>
            </span>
            <h3 className="mt-5 text-lg font-semibold tracking-tight text-slate-900">What are we building?</h3>
            <p className="mt-2 max-w-md text-sm leading-6 text-slate-500">
              Connect a project folder or upload a dataset, then ask the agent to inspect, transform, or query it.
            </p>
            <div className="mt-5 flex flex-wrap justify-center gap-2 text-xs text-slate-500">
              <span className="rounded-full border border-slate-200 bg-white px-3 py-1.5 shadow-sm">Profile a dataset</span>
              <span className="rounded-full border border-slate-200 bg-white px-3 py-1.5 shadow-sm">Build a pipeline</span>
              <span className="rounded-full border border-slate-200 bg-white px-3 py-1.5 shadow-sm">Run an analysis</span>
            </div>
          </div>
        ) : (
          messages.map((m) => <MessageBubble key={m.id} message={m} />)
        )}

        {isWorking && (
          <div role="status" aria-label={waitingForInput ? "Agent waiting for input" : "Agent working"} className="flex items-center gap-3 pl-11">
            <div className="flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-2 shadow-sm">
              <span className="typing-dot h-1.5 w-1.5 rounded-full bg-violet-500" />
              <span className="typing-dot h-1.5 w-1.5 rounded-full bg-violet-500" />
              <span className="typing-dot h-1.5 w-1.5 rounded-full bg-violet-500" />
              <span className="ml-1 text-xs font-medium text-slate-500">
                {waitingForInput ? "Waiting for your answer…" : "Working…"}
              </span>
            </div>
          </div>
        )}

        {error && (
          <p role="alert" className="rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-xs text-red-700">
            {error}
          </p>
        )}

        <div ref={bottomRef} />
      </div>
    </div>
  );
}
