import { Sidebar } from "./components/Sidebar";
import { ChatPane } from "./components/ChatPane";
import { DataPanel } from "./components/DataPanel";
import { useEvents } from "./hooks/useEvents";
import { useSessionStore } from "./store/sessionStore";

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

  return (
    <div className="grid h-screen grid-cols-[16rem_1fr_22rem] bg-slate-50 text-slate-900">
      <Sidebar
        activeSessionId={store.activeSessionId}
        onSelectSession={store.setActiveSession}
      />

      <main
        aria-label="Chat"
        className="flex flex-col overflow-hidden bg-slate-50"
      >
        {store.activeSessionId ? (
          <ChatPane
            sessionId={store.activeSessionId}
            state={store.activeState}
            appendUserMessage={store.appendUserMessage}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center px-6 text-sm text-slate-400">
            Start a session to chat with the agent
          </div>
        )}
      </main>

      <DataPanel state={store.activeState} sessionId={store.activeSessionId} />
    </div>
  );
}
