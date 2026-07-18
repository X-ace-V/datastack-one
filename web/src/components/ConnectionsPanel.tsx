import { useEffect, useRef, useState } from "react";
import {
  createConnection,
  deleteConnection,
  listConnections,
  testConnection,
  type Connection,
  type ConnectionTestResult,
} from "../lib/api";

/**
 * Settings → Connections panel (V5.3, PRD FR5). The ONLY place a database URL is entered: it adds,
 * tests, and removes a registered Postgres connection by name. The credentialed URL is typed here,
 * posted to the server on "Add", and then **cleared from local state immediately** — the browser
 * never retains it, and every later view (the list, a test result) carries only the connection
 * name/type and a scrubbed status. The agent references a connection by name via `attach_source`
 * (V5.2); this panel is where a human registers that name once.
 *
 * Rendered as a modal overlay from the shell (App) so it sits above the three-pane conversation
 * without a route. Its own state owns the connection list and its mutations, mirroring the Sidebar.
 */
export interface ConnectionsPanelProps {
  /** Close the panel and return to the conversation. */
  onClose: () => void;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A per-connection test outcome the panel shows inline: in-flight, or the resolved probe result. */
type TestState = "testing" | ConnectionTestResult;

export function ConnectionsPanel({ onClose }: ConnectionsPanelProps) {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [adding, setAdding] = useState(false);
  const [tests, setTests] = useState<Record<string, TestState>>({});

  // A write must invalidate a list read already in flight (AGENTS lesson): each load carries a
  // token; a stale load's result is dropped so a late mount GET cannot clobber a just-written list.
  const loadToken = useRef(0);

  const load = () => {
    const token = ++loadToken.current;
    setLoading(true);
    listConnections()
      .then((next) => {
        if (loadToken.current === token) {
          setConnections(next);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (loadToken.current === token) setError(messageOf(err));
      })
      .finally(() => {
        if (loadToken.current === token) setLoading(false);
      });
  };

  useEffect(() => {
    load();
    // Invalidate any in-flight load if the panel unmounts.
    return () => {
      loadToken.current++;
    };
  }, []);

  const canAdd = name.trim().length > 0 && url.trim().length > 0 && !adding;

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canAdd) return;
    setAdding(true);
    setError(null);
    try {
      await createConnection({ name: name.trim(), url: url.trim() });
      // The secret has reached the server; drop it from the browser at once (FR5).
      setName("");
      setUrl("");
      load();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setAdding(false);
    }
  };

  const handleTest = async (connName: string) => {
    setTests((prev) => ({ ...prev, [connName]: "testing" }));
    try {
      const result = await testConnection(connName);
      setTests((prev) => ({ ...prev, [connName]: result }));
    } catch (err) {
      setTests((prev) => ({ ...prev, [connName]: { ok: false, error: messageOf(err) } }));
    }
  };

  const handleRemove = async (connName: string) => {
    setError(null);
    try {
      await deleteConnection(connName);
      setTests((prev) => {
        const next = { ...prev };
        delete next[connName];
        return next;
      });
      load();
    } catch (err) {
      setError(messageOf(err));
    }
  };

  return (
    <div
      className="absolute inset-0 z-20 flex items-center justify-center bg-slate-900/40 p-6"
      onClick={onClose}
    >
      <section
        role="dialog"
        aria-label="Connections"
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-full w-full max-w-lg flex-col overflow-hidden rounded-lg bg-white shadow-xl"
      >
        <header className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <h2 className="text-sm font-semibold tracking-tight">Connections</h2>
          <button
            type="button"
            aria-label="Close connections"
            onClick={onClose}
            className="rounded px-2 py-0.5 text-sm text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          >
            ✕
          </button>
        </header>

        {error && (
          <p role="alert" className="border-b border-red-100 bg-red-50 px-5 py-2 text-xs text-red-600">
            {error}
          </p>
        )}

        <div className="flex-1 overflow-y-auto px-5 py-4">
          <form onSubmit={handleAdd} className="flex flex-col gap-2">
            <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
              Name
              <input
                aria-label="Connection name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="neon"
                className="rounded border border-slate-300 px-2 py-1 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
              Postgres URL
              <input
                aria-label="Connection URL"
                type="password"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="postgresql://user:password@host/db?sslmode=require"
                className="rounded border border-slate-300 px-2 py-1 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
            </label>
            <p className="text-xs text-slate-400">
              The URL is sent to the server and stored there — it never stays in the browser or
              reaches the agent.
            </p>
            <button
              type="submit"
              disabled={!canAdd}
              className="self-start rounded-md bg-indigo-600 px-3 py-1 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              Add connection
            </button>
          </form>

          <div className="mt-5 border-t border-slate-100 pt-4">
            {loading ? (
              <p className="text-sm text-slate-400">Loading connections…</p>
            ) : connections.length === 0 ? (
              <p className="text-sm text-slate-400">No connections yet</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {connections.map((conn) => {
                  const test = tests[conn.name];
                  return (
                    <li
                      key={conn.name}
                      className="flex flex-col gap-1 rounded border border-slate-200 px-3 py-2"
                    >
                      <div className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-800">
                          {conn.name}
                        </span>
                        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
                          {conn.type}
                        </span>
                        <button
                          type="button"
                          aria-label={`Test ${conn.name}`}
                          onClick={() => void handleTest(conn.name)}
                          disabled={test === "testing"}
                          className="rounded px-1.5 py-0.5 text-xs font-medium text-indigo-600 hover:bg-indigo-50 disabled:opacity-50"
                        >
                          Test
                        </button>
                        <button
                          type="button"
                          aria-label={`Remove ${conn.name}`}
                          onClick={() => void handleRemove(conn.name)}
                          className="rounded px-1.5 py-0.5 text-xs font-medium text-slate-400 hover:bg-red-50 hover:text-red-600"
                        >
                          Remove
                        </button>
                      </div>
                      {test && test !== "testing" && (
                        <p
                          role="status"
                          className={`text-xs ${test.ok ? "text-green-600" : "text-red-600"}`}
                        >
                          {test.ok ? "Connection OK" : `Failed: ${test.error ?? "unknown error"}`}
                        </p>
                      )}
                      {test === "testing" && (
                        <p role="status" className="text-xs text-slate-400">
                          Testing…
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
