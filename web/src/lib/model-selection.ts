import { useCallback, useState } from "react";

/**
 * The wizard's selected model (FR11), shared across steps.
 *
 * The model is chosen on the Plan step but is also recorded when a run starts on the Run step,
 * and the wizard's steps are independent routes that unmount each other — so the choice is
 * persisted rather than held in a parent's state. `localStorage` keeps one selection for the
 * whole session without threading a provider through every route.
 *
 * `null` means "no explicit choice" and is **not** the same as naming the free model: callers
 * omit the `model` field entirely, so the backend applies its own configured default. That keeps
 * the platform default in one place (the server) instead of duplicating it in the UI.
 */

/** `localStorage` key holding the selected `provider/model` ref. */
export const MODEL_SELECTION_STORAGE_KEY = "datastack-one.model";

/**
 * Read the persisted selection, or null when none is stored. Storage can throw (disabled cookies,
 * private browsing), which is not worth failing the page over — an unreadable selection is simply
 * no selection, and the platform default applies.
 */
export function readStoredModel(): string | null {
  try {
    const raw = window.localStorage.getItem(MODEL_SELECTION_STORAGE_KEY);
    return raw !== null && raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

/** Persist the selection, ignoring an unavailable storage (see {@link readStoredModel}). */
export function writeStoredModel(ref: string): void {
  try {
    window.localStorage.setItem(MODEL_SELECTION_STORAGE_KEY, ref);
  } catch {
    // A selection that cannot be persisted still applies to this page; it just will not follow
    // the user to the next step.
  }
}

/**
 * The selected `provider/model` and a setter that persists it. Reads storage once on mount, so a
 * model chosen on the Plan step is still selected when the Run step later records it on the run.
 */
export function useModelSelection(): [string | null, (ref: string) => void] {
  const [selected, setSelected] = useState<string | null>(() => readStoredModel());

  const select = useCallback((ref: string) => {
    setSelected(ref);
    writeStoredModel(ref);
  }, []);

  return [selected, select];
}
