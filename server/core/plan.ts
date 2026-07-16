import { z } from "zod";
import type { SourceProfile } from "./profile.js";

/**
 * Pure architecture-plan contract (PRD FR3). The plan stage prompts the agent to produce a
 * structured plan — execution pattern, warehouse, partitioning strategy and an ordered step
 * list — that a human reviews before anything executes. Because the OpenCode SDK's
 * `session.prompt` has no native json_schema output mode, "structured output" here means:
 * ask the model for a JSON object, then parse and validate it against {@link PlanSchema}.
 *
 * This module stays pure (no fs/net/process) so the schema, the prompt builder and the
 * response parser are unit-testable in isolation and reused by the plan stage
 * ({@link file://../pipeline/plan.ts}), the route and the UI. All I/O — creating a session,
 * prompting the model, persisting the artifact — lives outside `server/core`.
 */

/** One ordered step in the pipeline plan (e.g. "Land Parquet"). */
export const PlanStepSchema = z.object({
  /** Short step name. */
  name: z.string().min(1),
  /** What the step does, in one or two plain-English sentences. */
  description: z.string().min(1),
});
export type PlanStep = z.infer<typeof PlanStepSchema>;

/**
 * The architecture plan the agent produces (PRD FR3). Field values are validated as
 * non-empty rather than pinned to exact literals: the invariant the acceptance rubric
 * (LOOP.md §5) requires is that the plan *names* an execution pattern, a warehouse and a
 * non-empty step list — not that an LLM echoed a fixed string. The prompt still asks for
 * ELT / DuckDB / ingestion-date partitioning, so a well-behaved model fills those in.
 */
export const PlanSchema = z.object({
  /** Execution pattern the plan follows — the prompt requests "ELT". */
  executionPattern: z.string().min(1),
  /** Target warehouse — the prompt requests "duckdb". */
  warehouse: z.string().min(1),
  /** Partitioning strategy — the prompt requests partitioning landed data by ingestion date. */
  partitioning: z.string().min(1),
  /** Ordered pipeline steps; at least one is required for the plan to be usable. */
  steps: z.array(PlanStepSchema).min(1),
  /** Optional one-paragraph human summary of the plan. */
  summary: z.string().min(1).optional(),
});
export type Plan = z.infer<typeof PlanSchema>;

/**
 * Body of `POST /api/projects/:id/plan`. `sourceId` names the source to profile for context
 * (defaults to the project's newest upload, like the profile route); `model` is an optional
 * `provider/model` per-run override (PRD FR11) — omitted, the runtime's default free model
 * runs the stage. Both are optional, so the body may be absent entirely.
 */
export const PlanRequestSchema = z.object({
  /** Id of the source to profile for plan context; defaults to the newest source. */
  sourceId: z.string().min(1).optional(),
  /** `provider/model` override for this run; defaults to the configured free model. */
  model: z.string().min(1).optional(),
});
export type PlanRequest = z.infer<typeof PlanRequestSchema>;

/**
 * Thrown when the model's response cannot be turned into a valid {@link Plan} — no JSON
 * object present, malformed JSON, or a JSON object that fails schema validation. A route
 * maps this to `422 Unprocessable Entity`: the request was fine, the model output was not.
 */
export class PlanParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanParseError";
  }
}

/**
 * Split a `provider/model` ref (e.g. `opencode/big-pickle`) into the `{ providerID, modelID }`
 * shape `session.prompt` expects. Splits on the first `/` so a model id containing slashes is
 * preserved. Throws {@link PlanParseError} on a ref missing either half.
 */
export function parseModelRef(ref: string): { providerID: string; modelID: string } {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) {
    throw new PlanParseError(`invalid model ref "${ref}" (expected provider/model)`);
  }
  return { providerID: ref.slice(0, slash), modelID: ref.slice(slash + 1) };
}

/**
 * Build the constrained prompt for the plan stage. Returns a `system` instruction that pins
 * the role, the required JSON-only output and the target shape, plus a `prompt` carrying the
 * concrete profile and rules the model reasons over. Keeping this pure lets a test assert the
 * prompt actually contains the profile and the schema contract without spawning a model.
 */
export function buildPlanPrompt(input: {
  profile: SourceProfile;
  rules: string | null;
}): { system: string; prompt: string } {
  const { profile, rules } = input;

  const system = [
    "You are a senior data-platform architect. Given a profiled CSV source and optional",
    "transformation rules, produce an architecture plan for a local DuckDB data platform.",
    "",
    "Respond with a SINGLE JSON object and nothing else — no prose, no markdown fences.",
    "The object MUST have exactly these fields:",
    '- "executionPattern": string. Use "ELT" (extract, load, then transform in-warehouse).',
    '- "warehouse": string. Use "duckdb".',
    '- "partitioning": string. Partition landed data by ingestion date.',
    '- "steps": array of objects, each { "name": string, "description": string }, in order.',
    '- "summary": string. One short paragraph describing the plan.',
    "",
    "The steps MUST cover this six-stage pipeline in order: Extract, Land Parquet,",
    "Load Warehouse, Transform, DQ Checks, Publish.",
  ].join("\n");

  const columnLines = profile.columns
    .map(
      (c) =>
        `  - ${c.name}: ${c.type}` +
        `${c.isCandidateKey ? " (candidate key)" : ""}` +
        `${c.isDateColumn ? " (date)" : ""}` +
        ` — ${c.nullPercent}% null`,
    )
    .join("\n");

  const prompt = [
    "Profiled source:",
    `- rows: ${profile.rowCount}`,
    `- columns: ${profile.columnCount}`,
    `- candidate keys: ${profile.candidateKeys.length ? profile.candidateKeys.join(", ") : "(none)"}`,
    `- date columns: ${profile.dateColumns.length ? profile.dateColumns.join(", ") : "(none)"}`,
    "- schema:",
    columnLines,
    "",
    "Transformation rules:",
    rules && rules.trim().length > 0 ? rules.trim() : "(none provided)",
    "",
    "Produce the architecture plan as the JSON object described above.",
  ].join("\n");

  return { system, prompt };
}

/**
 * Extract the first balanced-looking JSON object from arbitrary model text and parse it. The
 * model may wrap the object in ```json fences or add stray prose, so we take the span from the
 * first `{` to the last `}` and `JSON.parse` it. Throws {@link PlanParseError} when no object
 * is present or the span is not valid JSON.
 */
export function extractJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new PlanParseError("no JSON object found in the model response");
  }
  const slice = text.slice(start, end + 1);
  try {
    return JSON.parse(slice) as unknown;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new PlanParseError(`model response was not valid JSON: ${message}`);
  }
}

/**
 * Parse a model response into a validated {@link Plan}: extract the JSON object, then validate
 * it against {@link PlanSchema}. Throws {@link PlanParseError} — with the failing fields — when
 * the object does not satisfy the plan contract, so a plausible-but-wrong output is rejected
 * rather than served (LOOP.md §5).
 */
export function parsePlanResponse(text: string): Plan {
  const json = extractJsonObject(text);
  const parsed = PlanSchema.safeParse(json);
  if (!parsed.success) {
    const summary = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new PlanParseError(`model response did not match the plan schema: ${summary}`);
  }
  return parsed.data;
}
