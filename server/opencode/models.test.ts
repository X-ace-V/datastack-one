import { describe, expect, it } from "vitest";
import { listModels, type ModelsClient } from "./models.js";
import { DEFAULT_MODEL } from "./config.js";
import { ModelsResponseSchema } from "../core/types.js";

/**
 * Unit tests for `listModels` (T1.2). Per TASKS.md these run against a *mocked*
 * client — no `opencode` subprocess — and assert the desired normalization values:
 * the flat `provider/model` refs, the free-vs-paid flag, stable model ordering, the
 * platform default, and the error path. The mock's shape mirrors the SDK's real
 * `config.providers()` payload so the mapping is exercised against the true contract.
 */

/** Build a `ModelsClient` whose `config.providers()` resolves to `response`. */
function mockClient(response: unknown): ModelsClient {
  return {
    config: { providers: async () => response },
  } as unknown as ModelsClient;
}

/** A providers payload shaped like the real `config.providers()` response. */
const PROVIDERS_FIXTURE = {
  data: {
    default: { opencode: "big-pickle", anthropic: "claude-opus-4-8" },
    providers: [
      {
        id: "opencode",
        name: "OpenCode Zen",
        source: "api",
        env: [],
        options: {},
        models: {
          // Intentionally out of alphabetical order to prove the sort.
          "grok-code": {
            id: "grok-code",
            name: "Grok Code",
            capabilities: { toolcall: true, reasoning: false },
            cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          },
          "big-pickle": {
            id: "big-pickle",
            name: "Big Pickle",
            capabilities: { toolcall: true, reasoning: false },
            cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          },
        },
      },
      {
        id: "anthropic",
        name: "Anthropic",
        source: "env",
        env: ["ANTHROPIC_API_KEY"],
        options: {},
        models: {
          "claude-opus-4-8": {
            id: "claude-opus-4-8",
            name: "Claude Opus 4.8",
            capabilities: { toolcall: true, reasoning: true },
            cost: { input: 15, output: 75, cache: { read: 1.5, write: 18.75 } },
          },
        },
      },
    ],
  },
  error: undefined,
};

describe("listModels", () => {
  it("returns a schema-valid response", async () => {
    const models = await listModels(mockClient(PROVIDERS_FIXTURE));
    expect(() => ModelsResponseSchema.parse(models)).not.toThrow();
  });

  it("reports the platform default model, not per-provider defaults", async () => {
    const models = await listModels(mockClient(PROVIDERS_FIXTURE));
    expect(models.default).toBe(DEFAULT_MODEL);
    expect(models.default).toBe("opencode/big-pickle");
  });

  it("flattens each model to a provider/model ref", async () => {
    const models = await listModels(mockClient(PROVIDERS_FIXTURE));
    const refs = models.providers.flatMap((p) => p.models.map((m) => m.ref));
    expect(refs).toEqual([
      "opencode/big-pickle",
      "opencode/grok-code",
      "anthropic/claude-opus-4-8",
    ]);
  });

  it("sorts models within a provider by model id", async () => {
    const models = await listModels(mockClient(PROVIDERS_FIXTURE));
    const opencode = models.providers.find((p) => p.id === "opencode")!;
    expect(opencode.models.map((m) => m.modelID)).toEqual(["big-pickle", "grok-code"]);
  });

  it("flags zero-cost models as free and priced models as not free", async () => {
    const models = await listModels(mockClient(PROVIDERS_FIXTURE));
    const byRef = new Map(
      models.providers.flatMap((p) => p.models).map((m) => [m.ref, m]),
    );
    expect(byRef.get("opencode/big-pickle")!.free).toBe(true);
    expect(byRef.get("opencode/grok-code")!.free).toBe(true);
    expect(byRef.get("anthropic/claude-opus-4-8")!.free).toBe(false);
  });

  it("carries capability and cost hints for the quality-tier toggle", async () => {
    const models = await listModels(mockClient(PROVIDERS_FIXTURE));
    const opus = models.providers
      .flatMap((p) => p.models)
      .find((m) => m.ref === "anthropic/claude-opus-4-8")!;
    expect(opus).toMatchObject({
      providerID: "anthropic",
      modelID: "claude-opus-4-8",
      name: "Claude Opus 4.8",
      toolcall: true,
      reasoning: true,
      cost: { input: 15, output: 75 },
    });
  });

  it("preserves provider identity and discovery source", async () => {
    const models = await listModels(mockClient(PROVIDERS_FIXTURE));
    expect(models.providers.map((p) => ({ id: p.id, name: p.name, source: p.source }))).toEqual([
      { id: "opencode", name: "OpenCode Zen", source: "api" },
      { id: "anthropic", name: "Anthropic", source: "env" },
    ]);
  });

  it("returns an empty provider list when the runtime reports none", async () => {
    const models = await listModels(
      mockClient({ data: { default: {}, providers: [] }, error: undefined }),
    );
    expect(models).toEqual({ default: DEFAULT_MODEL, providers: [] });
  });

  it("throws when the runtime returns an error", async () => {
    await expect(
      listModels(mockClient({ data: undefined, error: { message: "boom" } })),
    ).rejects.toThrow(/failed to list providers/);
  });
});
