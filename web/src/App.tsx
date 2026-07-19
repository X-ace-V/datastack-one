import { useEffect, useState } from "react";
import { Sidebar } from "./components/Sidebar";
import { ChatPane } from "./components/ChatPane";
import { SessionModelControl } from "./components/SessionModelControl";
import { DataPanel } from "./components/DataPanel";
import { ConnectionsPanel } from "./components/ConnectionsPanel";
import { useEvents } from "./hooks/useEvents";
import { useSessionStore } from "./store/sessionStore";
import { getSession } from "./lib/api";

/**
 * Application root — the frame the conversational shell renders inside: a session sidebar
 * (left), the chat stream (center), and the data panel (right).
 *
 * The v1 wizard's six step routes lived here and were removed with their pages. This is the v2
 * shell: one screen driven by the active session rather than a route per step. The live-state
 * store (V2.1) holds every session's transcript; one SSE subscription (V2.2) folds the whole
 * app's chat stream into it; the sidebar (V2.3) owns the session list and selects the active
 * session; the chat pane (V2.4) renders that session's turns and sends new ones; the data panel
 * (V3.3) renders the latest `run_query` result in the right region. Each region is a landmark with
 * an accessible name so the layout is navigable and testable region by region.
 */
export function App() {
  const store = useSessionStore();
  // One EventSource for the whole app; the store routes each event to its session by sessionID.
  useEvents({ onEvent: store.handleEvent });
  // Settings → Connections opens as a modal overlay above the conversation (V5.3), not a route.
  const [settingsOpen, setSettingsOpen] = useState(false);

  // The sidebar is driven by the same central index that global SSE events update, so an
  // inactive session can change title/status without forcing a refetch or being selected.
  useEffect(() => {
    void store.loadSessions();
  }, [store.loadSessions]);

  // Reopen (V6.2, FR1): when a session becomes active with no live state (a fresh page load, or
  // one created in a prior server run), fetch its persisted history and reconstruct the transcript
  // — messages AND their tool-block history. `hydrateSession` no-ops if the session already has
  // streamed content, so a slow fetch can never clobber an in-flight conversation.
  const { activeSessionId, getState, hydrateSession } = store;
  useEffect(() => {
    if (!activeSessionId) return;
    const existing = getState(activeSessionId);
    if (existing && (existing.messages.length > 0 || existing.isWorking)) return;
    let active = true;
    getSession(activeSessionId)
      .then((session) => {
        if (!active) return;
        hydrateSession(
          activeSessionId,
          session.messages
            .filter((m) => m.role === "user" || m.role === "assistant")
            .map((m) => ({
              role: m.role as "user" | "assistant",
              id: m.id,
              content: m.content,
              blocks: m.blocks,
              attachments: m.attachments,
            })),
        );
      })
      .catch(() => {
        // A failed reopen fetch leaves the session empty; the user can retry by reselecting it.
      });
    return () => {
      active = false;
    };
  }, [activeSessionId, getState, hydrateSession]);

  return (
    <div className="relative grid h-screen grid-cols-[16rem_1fr_22rem] bg-slate-50 text-slate-900">
      <Sidebar
        activeSessionId={store.activeSessionId}
        onSelectSession={store.setActiveSession}
        sessions={store.sessions}
        loading={store.sessionsLoading}
        loadError={store.sessionsError}
        onCreateSession={store.createSession}
        onRenameSession={store.renameSession}
        onDeleteSession={store.deleteSession}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <main
        aria-label="Chat"
        className="flex flex-col overflow-hidden bg-slate-50"
      >
        {store.activeSessionId ? (
          <>
            <div className="border-b border-slate-200 bg-white px-4 py-2">
              {/* Per-session model picker (V6.1): reflects and updates the active session's model. */}
              <SessionModelControl
                sessionId={store.activeSessionId}
                disabled={store.activeState.isWorking}
              />
            </div>
            <ChatPane
              sessionId={store.activeSessionId}
              state={store.activeState}
              appendUserMessage={store.appendUserMessage}
              setDraft={store.setDraft}
              uploadFiles={store.uploadFiles}
              retryAttachment={store.retryAttachment}
              removeAttachment={store.removeAttachment}
              clearReadyAttachments={store.clearReadyAttachments}
              loadFolder={store.loadFolder}
              openFolderSession={store.openFolderSession}
              refreshFolder={store.refreshFolder}
            />
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center px-6 text-sm text-slate-400">
            Start a session to chat with the agent
          </div>
        )}
      </main>

      <DataPanel state={store.activeState} sessionId={store.activeSessionId} />

      {settingsOpen && <ConnectionsPanel onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
