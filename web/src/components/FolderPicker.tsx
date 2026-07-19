import { useEffect, useState } from "react";
import { browseFolders, type FolderBrowseResult } from "../lib/api";

export function FolderPicker({
  onConnect,
  onClose,
}: {
  onConnect: (path: string) => Promise<void>;
  onClose: () => void;
}) {
  const [listing, setListing] = useState<FolderBrowseResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = (path?: string) => {
    setLoading(true);
    setError(null);
    browseFolders(path)
      .then(setListing)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  };

  useEffect(() => open(), []);

  const connect = async () => {
    if (!listing?.path) return;
    setConnecting(true);
    setError(null);
    try {
      await onConnect(listing.path);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setConnecting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/35 p-6">
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Start from local folder"
        className="flex max-h-[70vh] w-full max-w-xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl"
      >
        <header className="flex items-start justify-between border-b border-slate-200 px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">Start from a local folder</h2>
            <p className="mt-1 text-xs text-slate-500">
              This starts a new independent chat with the selected folder as the agent's working directory.
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close folder picker" className="text-slate-400 hover:text-slate-700">
            ×
          </button>
        </header>

        <div className="border-b border-slate-100 px-5 py-3">
          <p className="truncate font-mono text-xs text-slate-600">
            {listing?.path ?? "Allowed local folders"}
          </p>
        </div>

        {error && <p role="alert" className="bg-red-50 px-5 py-2 text-xs text-red-600">{error}</p>}

        <div className="min-h-48 flex-1 overflow-y-auto p-3">
          {loading ? (
            <p className="p-3 text-sm text-slate-400">Loading folders…</p>
          ) : (
            <ul className="space-y-1">
              {listing?.parent && (
                <li>
                  <button type="button" onClick={() => open(listing.parent!)} className="w-full rounded-md px-3 py-2 text-left text-sm text-slate-600 hover:bg-slate-100">
                    ↑ Parent folder
                  </button>
                </li>
              )}
              {(listing?.folders ?? []).map((folder) => (
                <li key={folder.path}>
                  <button type="button" onClick={() => open(folder.path)} className="w-full rounded-md px-3 py-2 text-left text-sm text-slate-700 hover:bg-indigo-50 hover:text-indigo-800">
                    <span aria-hidden="true">▸</span> {folder.name}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-slate-200 px-5 py-4">
          <button type="button" onClick={onClose} className="rounded-md px-3 py-2 text-sm text-slate-600 hover:bg-slate-100">Cancel</button>
          <button type="button" onClick={() => void connect()} disabled={!listing?.path || connecting} className="rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50">
            {connecting ? "Starting…" : "Start session here"}
          </button>
        </footer>
      </section>
    </div>
  );
}
