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
 * (left), the chat stream (center), and a contextual data panel that slides in only when the
 * active session has a schema, query result, endpoint, or audit event.
 *
 * The v1 wizard's six step routes lived here and were removed with their pages. This is the v2
 * shell: one screen driven by the active session rather than a route per step. The live-state
 * store (V2.1) holds every session's transcript; one SSE subscription (V2.2) folds the whole
 * app's chat stream into it; the sidebar (V2.3) owns the session list and selects the active
 * session; the chat pane (V2.4) renders that session's turns and sends new ones; the data panel
 * (V3.3) renders the latest `run_query` result in the right region. Visible regions are named
 * landmarks so the layout is navigable and testable region by region.
 */
export function App() {
  const store = useSessionStore();
  // One EventSource for the whole app; the store routes each event to its session by sessionID.
  useEvents({ onEvent: store.handleEvent });
  // Settings → Connections opens as a modal overlay above the conversation (V5.3), not a route.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [dataPanelOpen, setDataPanelOpen] = useState(false);

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
    <div
      className="app-shell relative grid h-screen overflow-hidden bg-slate-50 text-slate-900"
      data-data-open={dataPanelOpen ? "true" : "false"}
    >
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
        className="relative flex min-w-0 flex-col overflow-hidden bg-[radial-gradient(circle_at_50%_-20%,rgba(139,92,246,0.09),transparent_32rem)]"
      >
        {store.activeSessionId ? (
          <>
            <header className="flex min-h-16 items-center justify-between gap-4 border-b border-slate-200/80 bg-white/80 px-6 py-3 backdrop-blur-xl">
              <div className="min-w-0">
                <h2 className="truncate text-sm font-semibold text-slate-900">
                  {store.sessions.find((session) => session.id === store.activeSessionId)?.title ?? "Session"}
                </h2>
                <p className="mt-0.5 flex items-center gap-1.5 text-xs text-slate-500">
                  <span className={`h-1.5 w-1.5 rounded-full ${store.activeState.isWorking ? "animate-pulse bg-violet-500" : "bg-emerald-500"}`} />
                  {store.activeState.isWorking ? "Agent is working" : "Ready"}
                </p>
              </div>
              {/* Per-session model picker (V6.1): reflects and updates the active session's model. */}
              <SessionModelControl
                sessionId={store.activeSessionId}
                disabled={store.activeState.isWorking}
                compact
              />
            </header>
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
          <div className="flex flex-1 items-center justify-center px-6">
            <div className="max-w-lg text-center">
              <span className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-violet-100 text-violet-700 shadow-sm" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" className="h-8 w-8" stroke="currentColor" strokeWidth="1.6">
                  <path d="M4 7.5 12 3l8 4.5-8 4.5-8-4.5Z" />
                  <path d="m4 12 8 4.5 8-4.5M4 16.5 12 21l8-4.5" />
                </svg>
              </span>
              <h2 className="mt-5 text-2xl font-semibold tracking-tight text-slate-900">Build with your data</h2>
              <p className="mt-2 text-sm leading-6 text-slate-500">
                Start a session, connect a working folder, and let the data engineering agent profile, query, and ship your work.
              </p>
              <button
                type="button"
                onClick={() => void store.createSession().then((session) => store.setActiveSession(session.id))}
                className="mt-6 rounded-xl bg-slate-950 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-slate-900/10 transition hover:-translate-y-0.5 hover:bg-violet-700"
              >
                Start a new session
              </button>
            </div>
          </div>
        )}
      </main>

      <DataPanel
        state={store.activeState}
        sessionId={store.activeSessionId}
        onVisibilityChange={setDataPanelOpen}
      />

      {settingsOpen && <ConnectionsPanel onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
