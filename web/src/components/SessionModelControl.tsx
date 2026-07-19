import { useEffect, useRef, useState } from "react";
import { getSession, updateSessionModel } from "../lib/api";
import { ModelPicker } from "./ModelPicker";

/**
 * Binds the {@link ModelPicker} (FR11) to the active session's persisted model (V6.1). It reads
 * the session's stored `model` on mount, renders the picker preselected to it, and persists a
 * change with `PATCH /api/sessions/:id`. Model selection is **per session**: switching sessions
 * re-reads that session's model, and a change here only affects the session in the header.
 *
 * `null` means "no explicit choice" — the picker follows the catalog's platform default and the
 * backend applies it at prompt time, so the default lives in one place (the server) rather than
 * being duplicated into a stored row.
 */
export interface SessionModelControlProps {
  /** The active session whose model this controls. */
  sessionId: string;
  /** Disable the picker while a turn is in flight (the model is read per prompt). */
  disabled?: boolean;
  /** Use the compact control intended for the conversation header. */
  compact?: boolean;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function SessionModelControl({ sessionId, disabled = false, compact = false }: SessionModelControlProps) {
  const [model, setModel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // A monotonic token invalidates an in-flight session read: switching sessions or saving a new
  // model bumps it, so a slow load resolving late cannot clobber the current selection (the
  // write-invalidates-read guard AGENTS.md records for concurrent load/save on one page).
  const loadToken = useRef(0);

  useEffect(() => {
    const token = ++loadToken.current;
    setError(null);
    getSession(sessionId)
      .then((session) => {
        if (token === loadToken.current) setModel(session.model);
      })
      .catch((err: unknown) => {
        // A failed read is not fatal — the picker falls back to the platform default, which is
        // what an omitted model already resolves to on the backend.
        if (token === loadToken.current) setError(messageOf(err));
      });
  }, [sessionId]);

  const handleChange = (ref: string) => {
    // Invalidate any in-flight load so its late result cannot overwrite this choice.
    loadToken.current++;
    const previous = model;
    setModel(ref);
    setSaving(true);
    setError(null);
    updateSessionModel(sessionId, ref)
      .then((session) => setModel(session.model))
      .catch((err: unknown) => {
        // Revert the optimistic selection so the picker never shows a model that did not persist.
        setModel(previous);
        setError(messageOf(err));
      })
      .finally(() => setSaving(false));
  };

  return (
    <div>
      <ModelPicker value={model} onChange={handleChange} disabled={disabled || saving} compact={compact} />
      {error && (
        <p role="alert" className="mt-1 text-xs text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}
