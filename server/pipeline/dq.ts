import type { OpencodeClient, Part } from "@opencode-ai/sdk";
import type { SourceProfile } from "../core/profile.js";
import {
  buildDqPrompt,
  parseModelRef,
  parseDqResponse,
  type DqSpec,
} from "../core/dq.js";
import { ASK_TOOLS } from "../opencode/config.js";

/**
 * The data-quality stage (PRD FR7, ARCHITECTURE §3.3): drive one constrained `session.prompt`
 * that asks the agent to turn the profiled source + rules into ≥3 reviewable data-quality
 * checks, then validate the model's output into a {@link DqSpec}. This is an I/O module (it
 * talks to the OpenCode runtime) and lives under `server/pipeline`, not `server/core`; the
 * schema, prompt text and response parsing are the pure {@link file://../core/dq.ts}.
 *
 * The stage is deliberately tool-free — proposing checks is reasoning, not execution — so it
 * disables every mutating/permission-gated tool before prompting. That keeps the stage
 * deterministic and prevents the model from triggering a `permission.asked` that nobody is
 * there to answer during a plain generation call. Mirrors {@link file://./plan.ts} and
 * {@link file://./transform.ts}. Executing the checks (and blocking publish on failure) is the
 * later `run_dq_check` tool (T5.1), not this stage.
 */

/**
 * Minimal client surface the stage needs: `session.create` + `session.prompt`. Narrowing to
 * this slice keeps the stage mockable in a unit test without spawning the `opencode` server.
 */
export type DqClient = Pick<OpencodeClient, "session">;

/** Inputs to a single DQ-stage run. */
export interface RunDqStageInput {
  /** Profiled source (schema, types, keys, date cols) the checks are written against. */
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
 * {@link file://../core/dq.ts}'s `DqParseError` (bad *output*, mapped to 422).
 */
export class DqRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DqRuntimeError";
  }
}

/**
 * Built-in mutation surfaces gated in {@link file://../opencode/config.ts}. Disabled here
 * alongside the custom {@link ASK_TOOLS} so the generation prompt cannot invoke anything that
 * writes, executes, or blocks on a human approval.
 */
const BUILTIN_MUTATION_TOOLS = ["bash", "edit", "write", "patch", "webfetch"] as const;

/** A `{ tool: false }` map disabling every write/execute tool for the tool-free DQ stage. */
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
 * split across parts reconstructs exactly, which {@link parseDqResponse} then parses.
 */
function collectText(parts: Part[]): string {
  return parts
    .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
}

/**
 * Run the DQ stage against a session and return the validated {@link DqSpec}.
 *
 * Creates a fresh session, prompts the model with the constrained DQ prompt (tools disabled),
 * then parses the assistant's text into a spec. Throws {@link DqRuntimeError} when the runtime
 * fails and `DqParseError` (from core) when the model's output is not a valid spec — the caller
 * maps those to 502 and 422 respectively.
 */
export async function runDqStage(
  client: DqClient,
  input: RunDqStageInput,
): Promise<DqSpec> {
  const created = await client.session.create({
    body: { title: "DataStack One — DQ stage" },
  });
  if (created.error || !created.data) {
    throw new DqRuntimeError(
      `could not create a DQ session: ${JSON.stringify(created.error ?? "no session returned")}`,
    );
  }
  const sessionID = created.data.id;

  const { system, prompt } = buildDqPrompt({
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
    throw new DqRuntimeError(
      `the DQ prompt failed: ${JSON.stringify(res.error ?? "no response returned")}`,
    );
  }

  return parseDqResponse(collectText(res.data.parts));
}
