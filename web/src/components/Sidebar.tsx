import { useState } from "react";
import type { SessionSummary, SessionUiStatus } from "../store/sessionStore";

/**
 * The session sidebar (TASKS V2.3, PRD FR1, ARCHITECTURE §4): the list of chat sessions with
 * create / switch / rename / delete, wired to the `/api/sessions` REST surface. It is the left
 * pane of the three-pane shell and the only place a session is created or selected.
 *
 * The active session is controlled by the parent (`App`) so the chat stream (V2.4) and data
 * panel can follow it: this component owns the session *list* and its mutations, and reports the
 * selection up via {@link SidebarProps.onSelectSession}. Deleting the active session clears the
 * selection (there is nothing to show), and creating a session selects it immediately.
 */
export interface SidebarProps {
  /** The currently selected session, or null when none is active. */
  activeSessionId: string | null;
  /** Report a selection change up to the shell (a new id, a switch, or null on delete). */
  onSelectSession: (sessionId: string | null) => void;
  /** Central session index. It is updated by both REST mutations and global SSE events. */
  sessions: SessionSummary[];
  loading?: boolean;
  loadError?: string | null;
  onCreateSession: () => Promise<{ id: string }>;
  onRenameSession: (sessionId: string, title: string) => Promise<unknown>;
  onDeleteSession: (sessionId: string) => Promise<void>;
  /** Open the Settings → Connections panel (V5.3). Optional so the sidebar renders standalone. */
  onOpenSettings?: () => void;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function statusLabel(status: SessionUiStatus): string {
  if (status === "working") return "Working";
  if (status === "waiting_approval") return "Waiting for approval";
  if (status === "retry") return "Retrying";
  if (status === "error") return "Failed";
  return "Idle";
}

function StatusDot({ status }: { status: SessionUiStatus }) {
  const color =
    status === "working"
      ? "bg-violet-400 animate-pulse shadow-[0_0_0_3px_rgba(167,139,250,0.12)]"
      : status === "waiting_approval"
        ? "bg-amber-500 animate-pulse"
        : status === "retry"
          ? "bg-orange-500 animate-pulse"
          : status === "error"
            ? "bg-red-500"
            : "bg-slate-500";
  return (
    <span
      role="status"
      aria-label={statusLabel(status)}
      title={statusLabel(status)}
      className={`h-2 w-2 shrink-0 rounded-full ${color}`}
    />
  );
}

export function Sidebar({
  activeSessionId,
  onSelectSession,
  sessions,
  loading = false,
  loadError = null,
  onCreateSession,
  onRenameSession,
  onDeleteSession,
  onOpenSettings,
}: SidebarProps) {
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const handleCreate = async () => {
    setCreating(true);
    setError(null);
    try {
      const session = await onCreateSession();
      onSelectSession(session.id);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setCreating(false);
    }
  };

  const startRename = (session: SessionSummary) => {
    setEditingId(session.id);
    setDraftTitle(session.title);
    setConfirmDeleteId(null);
  };

  const cancelRename = () => {
    setEditingId(null);
    setDraftTitle("");
  };

  const submitRename = async (id: string) => {
    const title = draftTitle.trim();
    // A blank title is not a valid rename (the backend requires one); just leave edit mode.
    if (!title) {
      cancelRename();
      return;
    }
    setError(null);
    try {
      await onRenameSession(id, title);
      cancelRename();
    } catch (err) {
      setError(messageOf(err));
    }
  };

  const handleDelete = async (id: string) => {
    setError(null);
    try {
      await onDeleteSession(id);
      setConfirmDeleteId(null);
      // Keep the workspace useful after deleting the active session by selecting the next row.
      if (id === activeSessionId) {
        onSelectSession(sessions.find((session) => session.id !== id)?.id ?? null);
      }
    } catch (err) {
      setError(messageOf(err));
    }
  };

  return (
    <nav
      aria-label="Sessions"
      className="flex min-w-0 flex-col border-r border-white/5 bg-[#111522] text-slate-200 shadow-[12px_0_40px_-34px_rgba(15,23,42,0.9)]"
    >
      <header className="border-b border-white/7 px-4 pb-4 pt-5">
        <div className="mb-5 flex items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-indigo-600 text-white shadow-lg shadow-violet-950/40" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" stroke="currentColor" strokeWidth="1.8">
              <path d="M4 7.5 12 3l8 4.5-8 4.5-8-4.5Z" />
              <path d="m4 12 8 4.5 8-4.5M4 16.5 12 21l8-4.5" />
            </svg>
          </span>
          <div>
            <h1 className="text-sm font-semibold tracking-tight text-white">DataStack One</h1>
            <p className="text-[11px] text-slate-500">Data engineering workspace</p>
          </div>
        </div>
        <button
          type="button"
          aria-label="Create new session"
          onClick={handleCreate}
          disabled={creating}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-white px-3 py-2.5 text-xs font-semibold text-slate-950 shadow-sm transition hover:-translate-y-0.5 hover:bg-violet-50 disabled:opacity-50"
        >
          <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
          {creating ? "Creating…" : "New session"}
        </button>
      </header>

      {(error || loadError) && (
        <p role="alert" className="border-b border-red-400/10 bg-red-500/10 px-4 py-2 text-xs text-red-300">
          {error ?? loadError}
        </p>
      )}

      <div className="flex-1 overflow-y-auto px-2 py-3">
        {loading ? (
          <p className="px-3 py-3 text-sm text-slate-500">Loading sessions…</p>
        ) : sessions.length === 0 ? (
          <div className="px-3 py-6 text-center">
            <p className="text-sm font-medium text-slate-400">No sessions yet</p>
            <p className="mt-1 text-xs leading-5 text-slate-600">Create one to start working with your data.</p>
          </div>
        ) : (
          <ul className="space-y-1">
            {sessions.map((session) => {
              const isActive = session.id === activeSessionId;
              if (editingId === session.id) {
                return (
                  <li key={session.id} className="rounded-xl bg-white/5 px-2 py-2">
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        void submitRename(session.id);
                      }}
                      className="flex flex-col gap-1.5"
                    >
                      <input
                        aria-label="Session title"
                        value={draftTitle}
                        autoFocus
                        onChange={(e) => setDraftTitle(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Escape") cancelRename();
                        }}
                        className="w-full rounded-lg border border-white/10 bg-slate-950/50 px-2.5 py-1.5 text-sm text-white outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-400/10"
                      />
                      <div className="flex gap-1.5">
                        <button
                          type="submit"
                          className="rounded-md bg-violet-500 px-2.5 py-1 text-xs font-medium text-white hover:bg-violet-400"
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          onClick={cancelRename}
                          className="rounded-md px-2.5 py-1 text-xs font-medium text-slate-400 hover:bg-white/5 hover:text-white"
                        >
                          Cancel
                        </button>
                      </div>
                    </form>
                  </li>
                );
              }
              return (
                <li
                  key={session.id}
                  className={`group flex items-center gap-0.5 rounded-xl px-1.5 py-1.5 transition ${
                    isActive ? "bg-white/10 shadow-sm" : "hover:bg-white/[0.045]"
                  }`}
                >
                  <button
                    type="button"
                    aria-label={session.title}
                    aria-current={isActive ? "true" : undefined}
                    onClick={() => onSelectSession(session.id)}
                    className={`min-w-0 flex-1 truncate rounded-lg px-2 py-1.5 text-left text-sm ${
                      isActive ? "font-medium text-white" : "text-slate-400 group-hover:text-slate-200"
                    }`}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <StatusDot status={session.status} />
                      <span className="min-w-0 flex-1 truncate">{session.title}</span>
                    </span>
                  </button>
                  {confirmDeleteId === session.id ? (
                    <>
                      <button
                        type="button"
                        aria-label={`Confirm delete ${session.title}`}
                        onClick={() => void handleDelete(session.id)}
                        className="rounded-md bg-red-500/15 px-2 py-1 text-[11px] font-medium text-red-300 hover:bg-red-500/25"
                      >
                        Delete
                      </button>
                      <button
                        type="button"
                        aria-label={`Cancel delete ${session.title}`}
                        onClick={() => setConfirmDeleteId(null)}
                        className="rounded-md px-2 py-1 text-[11px] font-medium text-slate-400 hover:bg-white/5"
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        aria-label={`Rename ${session.title}`}
                        onClick={() => startRename(session)}
                        title="Rename"
                        className="flex h-7 w-7 items-center justify-center rounded-lg text-slate-500 opacity-0 transition hover:bg-white/10 hover:text-white focus:opacity-100 group-hover:opacity-100"
                      >
                        <svg viewBox="0 0 24 24" fill="none" className="h-3.5 w-3.5" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                          <path d="m4 20 4.2-1 10.7-10.7a2.1 2.1 0 0 0-3-3L5.2 16 4 20Z" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        aria-label={`Delete ${session.title}`}
                        onClick={() => setConfirmDeleteId(session.id)}
                        title="Delete"
                        className="flex h-7 w-7 items-center justify-center rounded-lg text-slate-500 opacity-0 transition hover:bg-red-500/15 hover:text-red-300 focus:opacity-100 group-hover:opacity-100"
                      >
                        <svg viewBox="0 0 24 24" fill="none" className="h-3.5 w-3.5" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                          <path d="M4 7h16M9 7V4h6v3m-9 0 1 13h10l1-13M10 11v5M14 11v5" />
                        </svg>
                      </button>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <footer className="border-t border-white/7 p-3">
        <button
          type="button"
          onClick={() => onOpenSettings?.()}
          className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-xs font-medium text-slate-400 transition hover:bg-white/5 hover:text-white"
        >
          <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1v.1h-4v-.1a1.7 1.7 0 0 0-1.1-1.6 1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1-.4h-.1v-4H3a1.7 1.7 0 0 0 1.6-1.1 1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1v-.1h4V3a1.7 1.7 0 0 0 1.1 1.6 1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9c.1.4.3.7.6 1 .3.2.6.4 1 .4h.1v4H21a1.7 1.7 0 0 0-1.6.6Z" />
          </svg>
          Settings · Connections
        </button>
      </footer>
    </nav>
  );
}
