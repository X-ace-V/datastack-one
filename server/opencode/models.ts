import type { OpencodeClient } from "@opencode-ai/sdk";
import { DEFAULT_MODEL } from "./config.js";
import { ModelsResponseSchema, type ModelsResponse } from "../core/types.js";

/**
 * Model listing for `GET /api/models` (PRD FR11). Reads live providers/models from the
 * OpenCode runtime via `config.providers()` and normalizes them into the flat, UI-ready
 * {@link ModelsResponse}. This is the one place the platform reads the model catalog;
 * the route and the ModelPicker consume its output. See ARCHITECTURE §8.
 */

/**
 * Minimal client surface {@link listModels} needs: just the `config.providers()` call.
 * Narrowing to this slice keeps the function trivially mockable in a unit test without
 * spawning the `opencode` server (TASKS.md T1.2: "test against a mocked client").
 */
export type ModelsClient = Pick<OpencodeClient, "config">;

/**
 * List the live providers and models the runtime exposes, normalized for the UI.
 *
 * The platform `default` is our configured free model ({@link DEFAULT_MODEL}), not the
 * per-provider defaults OpenCode returns — it is what the picker preselects. Each model
 * is flattened to a `provider/model` `ref` plus the capability/cost hints the quality
 * toggle uses. The result is validated against {@link ModelsResponseSchema} so a route
 * can trust it, and so a drift in the SDK's shape surfaces here rather than in the UI.
 *
 * @throws if the runtime returns an error instead of a provider list.
 */
export async function listModels(client: ModelsClient): Promise<ModelsResponse> {
  const res = await client.config.providers();
  if (res.error) {
    throw new Error(`failed to list providers: ${JSON.stringify(res.error)}`);
  }

  const providers = (res.data?.providers ?? []).map((provider) => ({
    id: provider.id,
    name: provider.name,
    source: provider.source,
    // `provider.models` is a map keyed by model id; flatten to a sorted array so the
    // picker renders in a stable order regardless of object-key iteration.
    models: Object.values(provider.models)
      .map((model) => ({
        ref: `${provider.id}/${model.id}`,
        providerID: provider.id,
        modelID: model.id,
        name: model.name,
        toolcall: model.capabilities.toolcall,
        reasoning: model.capabilities.reasoning,
        cost: { input: model.cost.input, output: model.cost.output },
        free: model.cost.input === 0 && model.cost.output === 0,
      }))
      .sort((a, b) => a.modelID.localeCompare(b.modelID)),
  }));

  return ModelsResponseSchema.parse({ default: DEFAULT_MODEL, providers });
}
