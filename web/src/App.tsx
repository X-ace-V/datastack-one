/**
 * Application root — the frame the conversational shell renders inside: a session sidebar, the
 * chat stream, and the data panel beside it.
 *
 * The v1 wizard's six step routes lived here and were removed with their pages. Nothing replaces
 * the routing yet: the shell is one screen driven by the active session rather than a route per
 * step, so what mounts here is decided by session state, not by the URL.
 */
export function App() {
  return <main className="min-h-screen bg-slate-50" />;
}
