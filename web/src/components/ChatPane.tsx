import { useCallback, useEffect, useState } from "react";
import { cancelChat, sendChat, type AttachmentRef } from "../lib/api";
import type { SessionLiveState } from "../store/sessionStore";
import { ChatStream } from "./ChatStream";
import { Composer } from "./Composer";
import { FolderPicker } from "./FolderPicker";

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
  appendUserMessage: (sessionId: string, text: string, attachments?: AttachmentRef[]) => string;
  setDraft: (sessionId: string, text: string) => void;
  uploadFiles: (sessionId: string, files: File[]) => void;
  retryAttachment: (sessionId: string, attachmentId: string) => void;
  removeAttachment: (sessionId: string, attachmentId: string) => void;
  clearReadyAttachments: (sessionId: string) => void;
  loadFolder: (sessionId: string) => Promise<void>;
  openFolderSession: (path: string) => Promise<unknown>;
  refreshFolder: (sessionId: string) => Promise<void>;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function ChatPane({
  sessionId,
  state,
  appendUserMessage,
  setDraft,
  uploadFiles,
  retryAttachment,
  removeAttachment,
  clearReadyAttachments,
  loadFolder,
  openFolderSession,
  refreshFolder,
}: ChatPaneProps) {
  const [sendError, setSendError] = useState<string | null>(null);
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);

  useEffect(() => {
    void loadFolder(sessionId);
  }, [loadFolder, sessionId]);

  const handleSend = useCallback(
    (text: string, attachments: AttachmentRef[] = []) => {
      setSendError(null);
      // Optimistically show the user's turn (and arm echo suppression) before the request; the
      // assistant's reply streams back over SSE.
      if (attachments.length > 0) appendUserMessage(sessionId, text, attachments);
      else appendUserMessage(sessionId, text);
      clearReadyAttachments(sessionId);
      sendChat(sessionId, text, undefined, attachments).catch((err: unknown) =>
        setSendError(messageOf(err)),
      );
    },
    [sessionId, appendUserMessage, clearReadyAttachments],
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
      <Composer
        isWorking={state.isWorking}
        value={state.draft}
        attachments={state.attachments}
        folder={state.folder}
        onChange={(text) => setDraft(sessionId, text)}
        onFiles={(files) => uploadFiles(sessionId, files)}
        onOpenFolder={() => setFolderPickerOpen(true)}
        onRefreshFolder={() => {
          void refreshFolder(sessionId).catch((err: unknown) => setSendError(messageOf(err)));
        }}
        onRemoveAttachment={(id) => removeAttachment(sessionId, id)}
        onRetryAttachment={(id) => retryAttachment(sessionId, id)}
        onSend={handleSend}
        onCancel={handleCancel}
      />
      {folderPickerOpen && (
        <FolderPicker
          onClose={() => setFolderPickerOpen(false)}
          onConnect={async (path) => {
            await openFolderSession(path);
          }}
        />
      )}
    </>
  );
}
