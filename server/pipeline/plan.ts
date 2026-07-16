import type { OpencodeClient, Part } from "@opencode-ai/sdk";
import type { SourceProfile } from "../core/profile.js";
import {
  buildPlanPrompt,
  parseModelRef,
  parsePlanResponse,
  type Plan,
} from "../core/plan.js";
import { ASK_TOOLS } from "../opencode/config.js";

/**
 * The plan stage (PRD FR3, ARCHITECTURE §3.3): drive one constrained `session.prompt` that
 * asks the agent for a structured architecture plan, then validate the model's output into a
 * {@link Plan}. This is the first pipeline stage that actually prompts a model, so it is an
 * I/O module (it talks to the OpenCode runtime) and lives under `server/pipeline`, not
 * `server/core`; the schema, prompt text and response parsing are the pure
 * {@link file://../core/plan.ts}.
 *
 * The stage is deliberately tool-free — planning is reasoning, not execution — so it disables
 * every mutating/permission-gated tool before prompting. That keeps the stage deterministic
 * and, crucially, prevents the model from triggering a `permission.asked` that nobody is
 * there to answer during a plain planning call.
 */

/**
 * Minimal client surface the stage needs: `session.create` + `session.prompt`. Narrowing to
 * this slice (as {@link file://../opencode/models.ts} does for `config`) keeps the stage
 * mockable in a unit test without spawning the `opencode` server.
 */
export type PlanClient = Pick<OpencodeClient, "session">;

/** Inputs to a single plan-stage run. */
export interface RunPlanStageInput {
  /** Profiled source (schema, types, keys, date cols) the plan reasons over. */
  profile: SourceProfile;
  /** The project's transformation rules, or `null` when none are on file yet. */
  rules: string | null;
  /** Optional `provider/model` override; omitted → the runtime's configured default. */
  model?: string;
}

/**
 * Thrown when the OpenCode runtime itself fails the stage — the session could not be created
 * or the prompt call returned an error envelope. A route maps this to `502 Bad Gateway`: the
 * request was fine, the upstream agent runtime failed. Distinct from
 * {@link file://../core/plan.ts}'s `PlanParseError` (bad *output*, mapped to 422).
 */
export class PlanRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanRuntimeError";
  }
}

/**
 * Built-in mutation surfaces gated in {@link file://../opencode/config.ts}. Disabled here
 * alongside the custom {@link ASK_TOOLS} so the planning prompt cannot invoke anything that
 * writes, executes, or blocks on a human approval.
 */
const BUILTIN_MUTATION_TOOLS = ["bash", "edit", "write", "patch", "webfetch"] as const;

/** A `{ tool: false }` map disabling every write/execute tool for the tool-free plan stage. */
function disabledToolsMap(): Record<string, boolean> {
  const map: Record<string, boolean> = {};
  for (const tool of [...ASK_TOOLS, ...BUILTIN_MUTATION_TOOLS]) {
    map[tool] = false;
  }
  return map;
}

/**
 * Concatenate every text part of a prompt response into one string. Parts are contiguous
 * chunks of the assistant's text output, so they are joined with no separator — a JSON payload
 * split across parts reconstructs exactly, which is what {@link parsePlanResponse} then parses.
 */
function collectText(parts: Part[]): string {
  return parts
    .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
}

/**
 * Run the plan stage against a session and return the validated {@link Plan}.
 *
 * Creates a fresh session, prompts the model with the constrained plan prompt (tools
 * disabled), then parses the assistant's text into a plan. Throws {@link PlanRuntimeError}
 * when the runtime fails and `PlanParseError` (from core) when the model's output is not a
 * valid plan — the caller maps those to 502 and 422 respectively.
 */
export async function runPlanStage(
  client: PlanClient,
  input: RunPlanStageInput,
): Promise<Plan> {
  const created = await client.session.create({
    body: { title: "DataStack One — plan stage" },
  });
  if (created.error || !created.data) {
    throw new PlanRuntimeError(
      `could not create a planning session: ${JSON.stringify(created.error ?? "no session returned")}`,
    );
  }
  const sessionID = created.data.id;

  const { system, prompt } = buildPlanPrompt({
    profile: input.profile,
    rules: input.rules,
  });
  const parts = [{ type: "text" as const, text: prompt }];
  const tools = disabledToolsMap();
  const body = input.model
    ? { system, tools, parts, model: parseModelRef(input.model) }
    : { system, tools, parts };

  const res = await client.session.prompt({ path: { id: sessionID }, body });
  if (res.error || !res.data) {
    throw new PlanRuntimeError(
      `the planning prompt failed: ${JSON.stringify(res.error ?? "no response returned")}`,
    );
  }

  return parsePlanResponse(collectText(res.data.parts));
}
