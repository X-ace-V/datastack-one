import type { ModelInfo, ModelProvider } from "./api";

/**
 * Pure logic behind the {@link file://../components/ModelPicker.tsx} quality-tier toggle (FR11,
 * ARCHITECTURE §8). Kept free of React so every derivation is unit-testable on its own, the same
 * split {@link file://./dashboard.ts} uses.
 *
 * The catalog is whatever the runtime actually offers right now — OpenCode discovers providers
 * from environment keys, so with no key set the *only* models that exist are the free ones. That
 * is why nothing here invents a tier: a tier is empty when the catalog says it is, and the picker
 * reports that rather than pretending a paid model is one click away.
 */

/**
 * The two quality tiers the toggle switches between (PRD §7's "one-click toggle to a stronger
 * paid model" when the free model flakes). Tier is derived from the catalog's `free` flag, so it
 * always reflects real cost rather than a hand-maintained list of model names.
 */
export const MODEL_TIERS = ["free", "quality"] as const;

export type ModelTier = (typeof MODEL_TIERS)[number];

/** Display labels for each tier. */
export const MODEL_TIER_LABELS: Record<ModelTier, string> = {
  free: "Free",
  quality: "Quality (paid)",
};

/** Which tier a model belongs to — the `free` flag is the single source of truth. */
export function tierOf(model: ModelInfo): ModelTier {
  return model.free ? "free" : "quality";
}

/** Every model across every provider, in catalog order. */
export function flattenModels(providers: ModelProvider[]): ModelInfo[] {
  return providers.flatMap((provider) => provider.models);
}

/** Look up a model by its `provider/model` ref, or null when the catalog does not offer it. */
export function findModel(providers: ModelProvider[], ref: string): ModelInfo | null {
  return flattenModels(providers).find((model) => model.ref === ref) ?? null;
}

/** Every model in one tier, in catalog order. Empty when the tier has no models available. */
export function modelsInTier(providers: ModelProvider[], tier: ModelTier): ModelInfo[] {
  return flattenModels(providers).filter((model) => tierOf(model) === tier);
}

/**
 * The providers of one tier, each carrying only that tier's models and dropping providers left
 * with none — the shape the picker renders as `<optgroup>`s.
 */
export function providersInTier(providers: ModelProvider[], tier: ModelTier): ModelProvider[] {
  return providers
    .map((provider) => ({
      ...provider,
      models: provider.models.filter((model) => tierOf(model) === tier),
    }))
    .filter((provider) => provider.models.length > 0);
}

/**
 * The model to select when switching to `tier`: the platform default when it belongs to that
 * tier (so the free tier lands on the configured free default rather than an arbitrary sibling),
 * otherwise the tier's first model in catalog order.
 *
 * Returns **null** when the tier is empty. Deliberately no fallback to another tier: switching to
 * a tier that does not exist must fail visibly, not silently select a model from the other one.
 * The order here is the backend's stable `modelID` sort — this picks a starting point for the
 * user to change, and never claims to be the "best" or "strongest" model in the tier.
 */
export function defaultRefForTier(
  providers: ModelProvider[],
  tier: ModelTier,
  platformDefault: string,
): string | null {
  const candidates = modelsInTier(providers, tier);
  const preferred = candidates.find((model) => model.ref === platformDefault);
  return (preferred ?? candidates[0])?.ref ?? null;
}

/**
 * A model's price, for display next to its name. Costs are quoted per **1M** tokens — the unit
 * the runtime reports (verified against the live catalog: `anthropic/claude-sonnet-4-5` comes
 * back as `3`/`15`, matching its published $3/$15 per-1M-token price).
 */
export function formatModelCost(model: ModelInfo): string {
  if (model.free) {
    return "free";
  }
  return `$${model.cost.input}/$${model.cost.output} per 1M tokens`;
}
