import { useCallback, useState } from "react";
import { cancelChat, sendChat } from "../lib/api";
import type { SessionLiveState } from "../store/sessionStore";
import { ChatStream } from "./ChatStream";
import { Composer } from "./Composer";

/**
 * The center pane of the shell (TASKS V2.4, PRD FR2): the {@link ChatStream} transcript above the
 * {@link Composer}. It owns the send/cancel wiring — an optimistic user bubble via the store, the
 * `POST /api/sessions/:id/chat` fire-and-forget turn (the answer streams back over SSE into the
 * store, not this request), and `POST …/cancel` to abort. A failed send/cancel surfaces inline
 * alongside any streamed turn error.
 */
export interface ChatPaneProps {
  /** The active session the composer sends to. */
  sessionId: string;
  /** The active session's live state (transcript, working flag, last error). */
  state: SessionLiveState;
  /** Append the user's turn to the store and arm echo suppression (returns its id). */
  appendUserMessage: (sessionId: string, text: string) => string;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function ChatPane({ sessionId, state, appendUserMessage }: ChatPaneProps) {
  const [sendError, setSendError] = useState<string | null>(null);

  const handleSend = useCallback(
    (text: string) => {
      setSendError(null);
      // Optimistically show the user's turn (and arm echo suppression) before the request; the
      // assistant's reply streams back over SSE.
      appendUserMessage(sessionId, text);
      sendChat(sessionId, text).catch((err: unknown) => setSendError(messageOf(err)));
    },
    [sessionId, appendUserMessage],
  );

  const handleCancel = useCallback(() => {
    setSendError(null);
    cancelChat(sessionId).catch((err: unknown) => setSendError(messageOf(err)));
  }, [sessionId]);

  return (
    <>
      <ChatStream
        messages={state.messages}
        isWorking={state.isWorking}
        error={state.error ?? sendError}
      />
      <Composer isWorking={state.isWorking} onSend={handleSend} onCancel={handleCancel} />
    </>
  );
}
