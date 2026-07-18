import type { Config } from "@opencode-ai/sdk";

/**
 * Pure OpenCode configuration for the DataStack One agent runtime. No I/O — this
 * module only builds the plain {@link Config} object that {@link file://./client.ts}
 * hands to `createOpencode`. Kept side-effect-free so the config can be asserted in
 * a fast unit test without spawning the `opencode` server. See ARCHITECTURE §6, §8.
 */

/**
 * Default model, per PRD FR11 / ARCHITECTURE §8: the free Zen model. Everything is
 * model-agnostic — a per-run override can replace this at prompt time — but the
 * platform boots on the free model so the demo costs nothing.
 */
export const DEFAULT_MODEL = "opencode/big-pickle";

/**
 * The custom data-engineering tools that write or execute and therefore require an
 * explicit human approval before they run (ARCHITECTURE §5, §6; PRD FR8). This is the
 * single source of truth for which tools the write-tool approval gate covers.
 *
 * NOTE: OpenCode's static `permission` config (below) only gates the built-in surfaces
 * (`edit`/`bash`/`webfetch`/…) — it cannot gate custom plugin tools, and a plugin tool's
 * `context.ask(...)` auto-resolves in the embedded runtime (verified live, see AGENTS.md). So
 * these tools are gated at the **backend**: each write tool's internal loopback route pauses on a
 * {@link file://./tool-approvals.ts} approval before it executes (V4.1). This list is the single
 * source of truth for which tools that gate covers. Never downgrade a tool off it (LOOP.md §8).
 */
export const ASK_TOOLS = [
  "land_parquet",
  "load_warehouse",
  "run_transform",
  "publish_serving",
  "attach_source",
] as const;

export type AskTool = (typeof ASK_TOOLS)[number];

/** Whether a tool name is on the human-approval ask-list. */
export function isAskTool(name: string): name is AskTool {
  return (ASK_TOOLS as readonly string[]).includes(name);
}

/**
 * Build the OpenCode {@link Config} for the DataStack One runtime.
 *
 * - `model`: the free default, overridable per call.
 * - `permission`: every built-in surface that can mutate the filesystem, run a shell,
 *   or reach the network is set to `ask`. Our agent performs all sanctioned writes
 *   through the custom data-eng tools (gated separately by the backend approval gate, see
 *   {@link ASK_TOOLS}), so gating the built-ins is defense-in-depth: no execution path — custom
 *   or built-in — can bypass human approval.
 *
 * `overrides` is shallow-merged, with `permission` merged one level deep, so a caller
 * (e.g. a test, or a future per-run model swap) can adjust one field without losing the
 * rest of the secure defaults.
 */
export function buildOpencodeConfig(overrides: Config = {}): Config {
  const { permission: permissionOverride, model: modelOverride, ...rest } = overrides;
  return {
    ...rest,
    model: modelOverride ?? DEFAULT_MODEL,
    permission: {
      edit: "ask",
      bash: "ask",
      webfetch: "ask",
      ...permissionOverride,
    },
  };
}
