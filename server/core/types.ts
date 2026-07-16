import { z } from "zod";

/**
 * Pure domain types + zod schemas. This module is the trusted contract shared by
 * routes, tools, and the OpenCode bridge. It must stay pure — no fs/net/process
 * imports — so it can be validated and reused anywhere. See ARCHITECTURE §3.2.
 */

/** Response contract for `GET /api/health`. */
export const HealthStatusSchema = z.object({
  /** Literal marker so clients can assert liveness, not just a 200. */
  status: z.literal("ok"),
  /** Service identity — guards against pointing the UI at the wrong backend. */
  service: z.literal("datastack-one"),
  /** Semver of the running backend. */
  version: z.string().min(1),
  /** Process uptime in seconds; non-negative. */
  uptime: z.number().nonnegative(),
});
export type HealthStatus = z.infer<typeof HealthStatusSchema>;

/**
 * A single selectable model in the `GET /api/models` response (PRD FR11). Normalized
 * from OpenCode's `config.providers()` into the flat shape the UI ModelPicker needs:
 * a `ref` it can hand straight back to a per-run `session.prompt({ model })`, plus the
 * capability + cost hints the quality-tier toggle uses to badge free vs paid models.
 */
export const ModelInfoSchema = z.object({
  /** `providerID/modelID` — the exact string used to select this model per run. */
  ref: z.string().min(1),
  /** Provider that serves the model (e.g. `opencode`, `anthropic`). */
  providerID: z.string().min(1),
  /** Model identifier within the provider (e.g. `big-pickle`). */
  modelID: z.string().min(1),
  /** Human-readable model name for display. */
  name: z.string().min(1),
  /** Whether the model can call tools — required for the scripted pipeline. */
  toolcall: z.boolean(),
  /** Whether the model exposes reasoning output. */
  reasoning: z.boolean(),
  /** Per-token cost in USD; `{0, 0}` marks a free model. */
  cost: z.object({ input: z.number().nonnegative(), output: z.number().nonnegative() }),
  /** True when both input and output cost are zero (the free tier). */
  free: z.boolean(),
});
export type ModelInfo = z.infer<typeof ModelInfoSchema>;

/** One provider and its available models, grouped for the UI picker. */
export const ModelProviderSchema = z.object({
  /** Provider id (e.g. `opencode`). */
  id: z.string().min(1),
  /** Human-readable provider name. */
  name: z.string().min(1),
  /** How OpenCode discovered the provider (`env`/`config`/`custom`/`api`). */
  source: z.string().min(1),
  /** Models this provider offers, in stable id order. */
  models: z.array(ModelInfoSchema),
});
export type ModelProvider = z.infer<typeof ModelProviderSchema>;

/** Response contract for `GET /api/models`. */
export const ModelsResponseSchema = z.object({
  /** The platform default model ref, preselected in the UI (PRD FR11). */
  default: z.string().min(1),
  /** Live providers with their models, from `config.providers()`. */
  providers: z.array(ModelProviderSchema),
});
export type ModelsResponse = z.infer<typeof ModelsResponseSchema>;
