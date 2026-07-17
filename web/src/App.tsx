import { useState } from "react";
import { Sidebar } from "./components/Sidebar";

/**
 * Application root — the frame the conversational shell renders inside: a session sidebar
 * (left), the chat stream (center), and the data panel (right).
 *
 * The v1 wizard's six step routes lived here and were removed with their pages. This is the v2
 * shell: one screen driven by the active session rather than a route per step. The sidebar
 * (V2.3) owns the session list and reports the active session up here; the chat stream (V2.4)
 * and data panel (V3.4) fill the other two regions in later tasks. Each region is a landmark
 * with an accessible name so the layout is navigable and testable region by region.
 */
export function App() {
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  return (
    <div className="grid h-screen grid-cols-[16rem_1fr_22rem] bg-slate-50 text-slate-900">
      <Sidebar activeSessionId={activeSessionId} onSelectSession={setActiveSessionId} />

      <main
        aria-label="Chat"
        className="flex flex-col overflow-hidden bg-slate-50"
      >
        <div className="flex flex-1 items-center justify-center px-6 text-sm text-slate-400">
          Start a session to chat with the agent
        </div>
      </main>

      <aside
        aria-label="Data panel"
        className="flex flex-col border-l border-slate-200 bg-white"
      >
        <header className="border-b border-slate-200 px-4 py-3">
          <h2 className="text-sm font-semibold tracking-tight">Data</h2>
        </header>
        <div className="flex flex-1 items-center justify-center px-4 text-sm text-slate-400">
          Schema, query results, and endpoints appear here
        </div>
      </aside>
    </div>
  );
}
