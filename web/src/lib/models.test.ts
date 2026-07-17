import { describe, expect, it } from "vitest";
import type { ModelInfo, ModelProvider } from "./api";
import {
  MODEL_TIERS,
  defaultRefForTier,
  findModel,
  flattenModels,
  formatModelCost,
  modelsInTier,
  providersInTier,
  tierOf,
} from "./models";

/**
 * Unit tests for the quality-tier logic behind the ModelPicker (FR11). The fixtures mirror the
 * real catalog observed from a live runtime: the free `opencode` provider is always present, and
 * `anthropic` only appears when `ANTHROPIC_API_KEY` is in the environment — which is exactly the
 * "quality tier is empty" case the picker has to handle honestly.
 */

function model(over: Partial<ModelInfo> & { ref: string }): ModelInfo {
  const [providerID = "", modelID = ""] = over.ref.split("/");
  return {
    providerID,
    modelID,
    name: modelID,
    toolcall: true,
    reasoning: true,
    cost: { input: 0, output: 0 },
    free: true,
    ...over,
  };
}

/** The live free catalog: one provider, six zero-cost models. */
const OPENCODE: ModelProvider = {
  id: "opencode",
  name: "OpenCode Zen",
  source: "custom",
  models: [
    model({ ref: "opencode/big-pickle", name: "Big Pickle" }),
    model({ ref: "opencode/hy3-free", name: "HY3" }),
  ],
};

/** Only discovered when a provider key is set; costs are USD per 1M tokens. */
const ANTHROPIC: ModelProvider = {
  id: "anthropic",
  name: "Anthropic",
  source: "env",
  models: [
    model({
      ref: "anthropic/claude-opus-4-5",
      name: "Claude Opus 4.5",
      cost: { input: 5, output: 25 },
      free: false,
    }),
    model({
      ref: "anthropic/claude-sonnet-4-5",
      name: "Claude Sonnet 4.5",
      cost: { input: 3, output: 15 },
      free: false,
    }),
  ],
};

const FREE_ONLY = [OPENCODE];
const BOTH = [ANTHROPIC, OPENCODE];

describe("model tiers", () => {
  it("offers exactly the free and quality tiers", () => {
    expect(MODEL_TIERS).toEqual(["free", "quality"]);
  });

  it("derives a model's tier from its free flag, not its provider", () => {
    expect(tierOf(model({ ref: "opencode/big-pickle" }))).toBe("free");
    expect(
      tierOf(model({ ref: "anthropic/claude-opus-4-5", free: false, cost: { input: 5, output: 25 } })),
    ).toBe("quality");
  });

  it("flattens every provider's models in catalog order", () => {
    expect(flattenModels(BOTH).map((m) => m.ref)).toEqual([
      "anthropic/claude-opus-4-5",
      "anthropic/claude-sonnet-4-5",
      "opencode/big-pickle",
      "opencode/hy3-free",
    ]);
  });

  it("finds a model by ref and returns null for one the catalog does not offer", () => {
    expect(findModel(BOTH, "opencode/hy3-free")?.name).toBe("HY3");
    expect(findModel(FREE_ONLY, "anthropic/claude-opus-4-5")).toBeNull();
  });

  it("splits the catalog into tiers", () => {
    expect(modelsInTier(BOTH, "free").map((m) => m.ref)).toEqual([
      "opencode/big-pickle",
      "opencode/hy3-free",
    ]);
    expect(modelsInTier(BOTH, "quality").map((m) => m.ref)).toEqual([
      "anthropic/claude-opus-4-5",
      "anthropic/claude-sonnet-4-5",
    ]);
  });

  it("reports an empty quality tier when no paid provider is configured", () => {
    expect(modelsInTier(FREE_ONLY, "quality")).toEqual([]);
    expect(providersInTier(FREE_ONLY, "quality")).toEqual([]);
  });

  it("groups a tier by provider, dropping providers with nothing in that tier", () => {
    const grouped = providersInTier(BOTH, "quality");
    expect(grouped).toHaveLength(1);
    expect(grouped[0]?.id).toBe("anthropic");
    expect(grouped[0]?.models.map((m) => m.ref)).toEqual([
      "anthropic/claude-opus-4-5",
      "anthropic/claude-sonnet-4-5",
    ]);
  });

  it("prefers the platform default when switching to the tier that holds it", () => {
    // The free tier lands on the configured default rather than the first free sibling.
    expect(defaultRefForTier(BOTH, "free", "opencode/big-pickle")).toBe("opencode/big-pickle");
  });

  it("falls back to a tier's first model when the platform default is not in it", () => {
    expect(defaultRefForTier(BOTH, "quality", "opencode/big-pickle")).toBe(
      "anthropic/claude-opus-4-5",
    );
  });

  it("returns null for an empty tier rather than selecting from the other one", () => {
    // Switching to a tier that does not exist must fail visibly, never silently pick a free model.
    expect(defaultRefForTier(FREE_ONLY, "quality", "opencode/big-pickle")).toBeNull();
  });

  it("prices a paid model per 1M tokens and marks a free one free", () => {
    expect(formatModelCost(ANTHROPIC.models[1] as ModelInfo)).toBe("$3/$15 per 1M tokens");
    expect(formatModelCost(OPENCODE.models[0] as ModelInfo)).toBe("free");
  });
});
