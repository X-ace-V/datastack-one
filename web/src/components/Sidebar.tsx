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
      ? "bg-indigo-500 animate-pulse"
      : status === "waiting_approval"
        ? "bg-amber-500 animate-pulse"
        : status === "retry"
          ? "bg-orange-500 animate-pulse"
          : status === "error"
            ? "bg-red-500"
            : "bg-slate-300";
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
      className="flex flex-col border-r border-slate-200 bg-white"
    >
      <header className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
        <h1 className="text-sm font-semibold tracking-tight">DataStack One</h1>
        <button
          type="button"
          onClick={handleCreate}
          disabled={creating}
          className="rounded-md bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          New session
        </button>
      </header>

      {(error || loadError) && (
        <p role="alert" className="border-b border-red-100 bg-red-50 px-4 py-2 text-xs text-red-600">
          {error ?? loadError}
        </p>
      )}

      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <p className="px-4 py-3 text-sm text-slate-400">Loading sessions…</p>
        ) : sessions.length === 0 ? (
          <p className="px-4 py-3 text-sm text-slate-400">No sessions yet</p>
        ) : (
          <ul>
            {sessions.map((session) => {
              const isActive = session.id === activeSessionId;
              if (editingId === session.id) {
                return (
                  <li key={session.id} className="border-b border-slate-100 px-2 py-2">
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
                        className="w-full rounded border border-slate-300 px-2 py-1 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                      />
                      <div className="flex gap-1.5">
                        <button
                          type="submit"
                          className="rounded bg-indigo-600 px-2 py-0.5 text-xs font-medium text-white hover:bg-indigo-500"
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          onClick={cancelRename}
                          className="rounded px-2 py-0.5 text-xs font-medium text-slate-600 hover:bg-slate-100"
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
                  className={`group flex items-center gap-1 border-b border-slate-100 px-2 py-1 ${
                    isActive ? "bg-indigo-50" : "hover:bg-slate-50"
                  }`}
                >
                  <button
                    type="button"
                    aria-label={session.title}
                    aria-current={isActive ? "true" : undefined}
                    onClick={() => onSelectSession(session.id)}
                    className={`min-w-0 flex-1 truncate rounded px-2 py-1 text-left text-sm ${
                      isActive ? "font-medium text-indigo-900" : "text-slate-700"
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
                        className="rounded px-1.5 py-0.5 text-xs font-medium text-red-600 hover:bg-red-50"
                      >
                        Delete
                      </button>
                      <button
                        type="button"
                        aria-label={`Cancel delete ${session.title}`}
                        onClick={() => setConfirmDeleteId(null)}
                        className="rounded px-1.5 py-0.5 text-xs font-medium text-slate-500 hover:bg-slate-100"
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
                        className="rounded px-1.5 py-0.5 text-xs text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                      >
                        Rename
                      </button>
                      <button
                        type="button"
                        aria-label={`Delete ${session.title}`}
                        onClick={() => setConfirmDeleteId(session.id)}
                        className="rounded px-1.5 py-0.5 text-xs text-slate-400 hover:bg-red-50 hover:text-red-600"
                      >
                        Delete
                      </button>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <footer className="border-t border-slate-200 px-2 py-2">
        <button
          type="button"
          onClick={() => onOpenSettings?.()}
          className="w-full rounded px-2 py-1 text-left text-xs font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-700"
        >
          Settings · Connections
        </button>
      </footer>
    </nav>
  );
}
