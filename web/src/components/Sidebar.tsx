import { useEffect, useState } from "react";
import {
  createSession,
  deleteSession,
  listSessions,
  renameSession,
  type Session,
} from "../lib/api";

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
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function Sidebar({ activeSessionId, onSelectSession }: SidebarProps) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    listSessions()
      .then((next) => {
        if (active) {
          setSessions(next);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (active) setError(messageOf(err));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const handleCreate = async () => {
    setCreating(true);
    setError(null);
    try {
      const session = await createSession();
      // A new session is the most recent, so it goes to the top and becomes active.
      setSessions((prev) => [session, ...prev]);
      onSelectSession(session.id);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setCreating(false);
    }
  };

  const startRename = (session: Session) => {
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
      const updated = await renameSession(id, title);
      setSessions((prev) => prev.map((s) => (s.id === id ? updated : s)));
      cancelRename();
    } catch (err) {
      setError(messageOf(err));
    }
  };

  const handleDelete = async (id: string) => {
    setError(null);
    try {
      await deleteSession(id);
      setSessions((prev) => prev.filter((s) => s.id !== id));
      setConfirmDeleteId(null);
      // The active session no longer exists — clear the selection so the shell shows nothing.
      if (id === activeSessionId) onSelectSession(null);
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

      {error && (
        <p role="alert" className="border-b border-red-100 bg-red-50 px-4 py-2 text-xs text-red-600">
          {error}
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
                    aria-current={isActive ? "true" : undefined}
                    onClick={() => onSelectSession(session.id)}
                    className={`min-w-0 flex-1 truncate rounded px-2 py-1 text-left text-sm ${
                      isActive ? "font-medium text-indigo-900" : "text-slate-700"
                    }`}
                  >
                    {session.title}
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
    </nav>
  );
}
