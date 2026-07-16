import type { OpencodeClient, Part } from "@opencode-ai/sdk";
import type { SourceProfile } from "../core/profile.js";
import {
  buildTransformPrompt,
  parseModelRef,
  parseTransformResponse,
  type Transform,
} from "../core/transform.js";
import { ASK_TOOLS } from "../opencode/config.js";

/**
 * The transform stage (PRD FR6, ARCHITECTURE §3.3): drive one constrained `session.prompt` that
 * asks the agent to turn the rules doc + profiled schema into reviewable transformation SQL,
 * then validate the model's output into a {@link Transform}. This is an I/O module (it talks to
 * the OpenCode runtime) and lives under `server/pipeline`, not `server/core`; the schema, prompt
 * text and response parsing are the pure {@link file://../core/transform.ts}.
 *
 * The stage is deliberately tool-free — generating SQL is reasoning, not execution — so it
 * disables every mutating/permission-gated tool before prompting. That keeps the stage
 * deterministic and prevents the model from triggering a `permission.asked` that nobody is
 * there to answer during a plain generation call. Mirrors {@link file://./plan.ts}.
 */

/**
 * Minimal client surface the stage needs: `session.create` + `session.prompt`. Narrowing to
 * this slice keeps the stage mockable in a unit test without spawning the `opencode` server.
 */
export type TransformClient = Pick<OpencodeClient, "session">;

/** Inputs to a single transform-stage run. */
export interface RunTransformStageInput {
  /** Profiled source (schema, types, keys, date cols) the SQL is written against. */
  profile: SourceProfile;
  /** The project's plain-English transformation rules — required; SQL is generated from them. */
  rules: string;
  /** Optional `provider/model` override; omitted → the runtime's configured default. */
  model?: string;
}

/**
 * Thrown when the OpenCode runtime itself fails the stage — the session could not be created
 * or the prompt call returned an error envelope. A route maps this to `502 Bad Gateway`: the
 * request was fine, the upstream agent runtime failed. Distinct from
 * {@link file://../core/transform.ts}'s `TransformParseError` (bad *output*, mapped to 422).
 */
export class TransformRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransformRuntimeError";
  }
}

/**
 * Built-in mutation surfaces gated in {@link file://../opencode/config.ts}. Disabled here
 * alongside the custom {@link ASK_TOOLS} so the generation prompt cannot invoke anything that
 * writes, executes, or blocks on a human approval.
 */
const BUILTIN_MUTATION_TOOLS = ["bash", "edit", "write", "patch", "webfetch"] as const;

/** A `{ tool: false }` map disabling every write/execute tool for the tool-free transform stage. */
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
 * split across parts reconstructs exactly, which {@link parseTransformResponse} then parses.
 */
function collectText(parts: Part[]): string {
  return parts
    .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
}

/**
 * Run the transform stage against a session and return the validated {@link Transform}.
 *
 * Creates a fresh session, prompts the model with the constrained transform prompt (tools
 * disabled), then parses the assistant's text into a transform. Throws
 * {@link TransformRuntimeError} when the runtime fails and `TransformParseError` (from core)
 * when the model's output is not a valid transform — the caller maps those to 502 and 422.
 */
export async function runTransformStage(
  client: TransformClient,
  input: RunTransformStageInput,
): Promise<Transform> {
  const created = await client.session.create({
    body: { title: "DataStack One — transform stage" },
  });
  if (created.error || !created.data) {
    throw new TransformRuntimeError(
      `could not create a transform session: ${JSON.stringify(created.error ?? "no session returned")}`,
    );
  }
  const sessionID = created.data.id;

  const { system, prompt } = buildTransformPrompt({
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
    throw new TransformRuntimeError(
      `the transform prompt failed: ${JSON.stringify(res.error ?? "no response returned")}`,
    );
  }

  return parseTransformResponse(collectText(res.data.parts));
}
