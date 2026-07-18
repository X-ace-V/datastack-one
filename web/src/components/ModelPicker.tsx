import { useEffect, useState } from "react";
import { listModels, type ModelCatalog } from "../lib/api";
import {
  MODEL_TIERS,
  MODEL_TIER_LABELS,
  defaultRefForTier,
  findModel,
  formatModelCost,
  modelsInTier,
  providersInTier,
  tierOf,
  type ModelTier,
} from "../lib/models";

/**
 * Selects the model the agent runs on (FR11, ARCHITECTURE §8): a quality-tier toggle plus a
 * provider-grouped model list, populated live from `GET /api/models`. Wired per session by
 * {@link file://./SessionModelControl.tsx} (V6.1).
 *
 * The tier toggle is PRD §7's mitigation for "the free model is too weak" — one click moves the
 * session onto a paid model. It is honest about what is actually reachable: the runtime only
 * discovers a paid provider when its API key is in the environment, so with no key the quality
 * tier genuinely has no models and the picker says which key to set instead of offering a
 * selection that would fail at prompt time.
 */

export interface ModelPickerProps {
  /**
   * The selected `provider/model`, or null to follow the platform default. Null is not resolved
   * to a ref here — the caller omits the model from its request so the backend applies its own
   * default (see {@link file://../lib/model-selection.ts}).
   */
  value: string | null;
  /** Called with the chosen `provider/model` ref. */
  onChange: (ref: string) => void;
  /** Disables the control, e.g. while a turn is in flight. */
  disabled?: boolean;
}

export function ModelPicker({ value, onChange, disabled = false }: ModelPickerProps) {
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    listModels()
      .then((next) => {
        if (active) setCatalog(next);
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      active = false;
    };
  }, []);

  // A catalog we could not read is reported rather than replaced with an empty list: an empty
  // picker would read as "no models exist", when the truth is that we do not know what exists.
  // Generation still works — omitting the override leaves the backend on its default.
  if (error) {
    return (
      <div>
        <p className="text-sm font-medium text-slate-700">Model</p>
        <p role="alert" className="mt-1 text-sm text-red-600">
          {error}
        </p>
        <p className="mt-1 text-xs text-slate-500">
          Generation will use the platform's default free model.
        </p>
      </div>
    );
  }

  if (!catalog) {
    return (
      <div>
        <p className="text-sm font-medium text-slate-700">Model</p>
        <p className="mt-1 text-xs text-slate-500">Loading models…</p>
      </div>
    );
  }

  const effectiveRef = value ?? catalog.default;
  const current = findModel(catalog.providers, effectiveRef);
  // With no selection resolvable, the free tier is the honest default view — it is the tier the
  // platform boots on, and the note below explains an unavailable selection rather than hiding it.
  const activeTier: ModelTier = current ? tierOf(current) : "free";
  const qualityAvailable = modelsInTier(catalog.providers, "quality").length > 0;

  // An arrow const rather than a function declaration: a hoisted declaration would lose the
  // non-null narrowing `catalog` has by this point.
  const handleTier = (tier: ModelTier) => {
    if (tier === activeTier) return;
    const ref = defaultRefForTier(catalog.providers, tier, catalog.default);
    // A null ref means the tier is empty; its button is already disabled, and selecting a model
    // from the other tier instead would silently contradict the click.
    if (ref) onChange(ref);
  };

  return (
    <div>
      <label htmlFor="model-picker" className="block text-sm font-medium text-slate-700">
        Model
      </label>
      <p className="mt-1 text-xs text-slate-500">
        The model this session's agent reasons and calls tools with. The data tools run the same
        either way — the model chooses the steps, not what they can do.
      </p>

      <div
        role="group"
        aria-label="Quality tier"
        className="mt-2 inline-flex gap-1 rounded-md border border-slate-300 p-0.5"
      >
        {MODEL_TIERS.map((tier) => {
          const available = modelsInTier(catalog.providers, tier).length > 0;
          const active = tier === activeTier;
          return (
            <button
              key={tier}
              type="button"
              aria-pressed={active}
              disabled={disabled || !available}
              onClick={() => handleTier(tier)}
              className={`rounded px-2.5 py-1 text-xs font-medium disabled:opacity-50 ${
                active ? "bg-indigo-600 text-white" : "text-slate-700 hover:bg-slate-50"
              }`}
            >
              {MODEL_TIER_LABELS[tier]}
            </button>
          );
        })}
      </div>

      <select
        id="model-picker"
        value={effectiveRef}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="mt-2 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:bg-slate-100"
      >
        {/* A stored ref the runtime no longer offers (e.g. its provider key was removed) stays
            visible as the selection instead of the browser silently showing another option. */}
        {!current && <option value={effectiveRef}>{effectiveRef} (unavailable)</option>}
        {providersInTier(catalog.providers, activeTier).map((provider) => (
          <optgroup key={provider.id} label={provider.name}>
            {provider.models.map((model) => (
              <option key={model.ref} value={model.ref}>
                {model.name} — {formatModelCost(model)}
              </option>
            ))}
          </optgroup>
        ))}
      </select>

      {current ? (
        <p className="mt-1 text-xs text-slate-500">
          <span className="font-mono">{current.ref}</span> — {formatModelCost(current)}
        </p>
      ) : (
        <p role="alert" className="mt-1 text-xs text-amber-700">
          This model is not offered by the runtime right now — its provider key may be missing.
          Pick an available model below, or generation will fail.
        </p>
      )}

      {!qualityAvailable && (
        <p className="mt-1 text-xs text-slate-500">
          No paid provider is configured, so the quality tier is empty. Set a provider key (e.g.{" "}
          <code className="font-mono">ANTHROPIC_API_KEY</code>) in <code className="font-mono">.env</code>{" "}
          and restart the server to enable it.
        </p>
      )}
    </div>
  );
}
