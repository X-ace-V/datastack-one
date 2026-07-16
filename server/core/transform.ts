import { z } from "zod";
import type { SourceProfile } from "./profile.js";

/**
 * Pure transform-generation contract (PRD FR6). The transform stage prompts the agent to turn
 * the plain-English rules doc (plus the profiled schema) into reviewable transformation SQL,
 * *surfacing the assumptions it made and any clarifying questions* so a human can vet the SQL
 * before it ever runs (execution is the later `run_transform` tool, T4.3). As with the plan
 * stage, the OpenCode SDK's `session.prompt` has no native json_schema mode, so "structured
 * output" means: ask the model for one JSON object, then parse and validate it against
 * {@link TransformSchema}.
 *
 * This module stays pure (no fs/net/process) — the schema, prompt builder, model-ref splitter
 * and response parser are unit-testable in isolation and reused by the transform stage
 * ({@link file://../pipeline/transform.ts}), the route and the UI. The extraction and model-ref
 * helpers mirror {@link file://./plan.ts}'s on purpose: each stage stays self-contained with its
 * own {@link TransformParseError} typing so the route can map a bad *output* to 422 cleanly.
 */

/**
 * The generated transform the agent produces (PRD FR6). `sql` is the transformation statement a
 * human reviews before it executes; `assumptions` and `questions` are the FR6 "surfaced
 * assumptions and clarifying questions" — both are required arrays (possibly empty) so the
 * contract always *carries* them rather than letting the model silently omit them. `targetTable`
 * is the unqualified `marts` table the SQL creates, which the later run stage executes into.
 */
export const TransformSchema = z.object({
  /** The transformation SQL to review then run — a non-empty statement. */
  sql: z.string().min(1),
  /** Unqualified name of the `marts` table the SQL creates (e.g. `loan_summary`). */
  targetTable: z.string().min(1),
  /** Assumptions the agent made about the data or rules; empty when it made none. */
  assumptions: z.array(z.string()),
  /** Clarifying questions where the rules were ambiguous; empty when the rules were clear. */
  questions: z.array(z.string()),
});
export type Transform = z.infer<typeof TransformSchema>;

/**
 * Body of `POST /api/projects/:id/transform`. `sourceId` names the source to profile for
 * context (defaults to the project's newest upload, like the plan route); `model` is an
 * optional `provider/model` per-run override (PRD FR11). Both optional, so the body may be
 * absent entirely.
 */
export const TransformRequestSchema = z.object({
  /** Id of the source to profile for schema context; defaults to the newest source. */
  sourceId: z.string().min(1).optional(),
  /** `provider/model` override for this run; defaults to the configured free model. */
  model: z.string().min(1).optional(),
});
export type TransformRequest = z.infer<typeof TransformRequestSchema>;

/**
 * Thrown when the model's response cannot be turned into a valid {@link Transform} — no JSON
 * object present, malformed JSON, a bad `provider/model` ref, or a JSON object that fails
 * schema validation. A route maps this to `422 Unprocessable Entity`: the request was fine,
 * the model output was not. Distinct from the pipeline's `TransformRuntimeError` (→ 502).
 */
export class TransformParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransformParseError";
  }
}

/**
 * Split a `provider/model` ref (e.g. `opencode/big-pickle`) into the `{ providerID, modelID }`
 * shape `session.prompt` expects. Splits on the first `/` so a model id containing slashes is
 * preserved. Throws {@link TransformParseError} on a ref missing either half.
 */
export function parseModelRef(ref: string): { providerID: string; modelID: string } {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) {
    throw new TransformParseError(`invalid model ref "${ref}" (expected provider/model)`);
  }
  return { providerID: ref.slice(0, slash), modelID: ref.slice(slash + 1) };
}

/** The `raw`-schema table the landed source data is loaded into (T4.2) and the transform reads. */
export const SOURCE_TABLE = "raw.source";

/**
 * Build the constrained prompt for the transform stage. Returns a `system` instruction pinning
 * the role, the required JSON-only output shape and the DuckDB `raw`→`marts` convention, plus a
 * `prompt` carrying the concrete profiled schema and the rules the model turns into SQL. Keeping
 * this pure lets a test assert the prompt actually carries the schema and rules without a model.
 */
export function buildTransformPrompt(input: {
  profile: SourceProfile;
  rules: string;
}): { system: string; prompt: string } {
  const { profile, rules } = input;

  const system = [
    "You are a senior analytics engineer. Given a profiled CSV source and the plain-English",
    "transformation rules for it, write the transformation SQL for a local DuckDB ELT pipeline.",
    "",
    `The landed source data is available as the table ${SOURCE_TABLE} with the columns below.`,
    "Write a SINGLE DuckDB SQL statement that creates the transformed marts table with",
    `CREATE OR REPLACE TABLE marts.<target> AS SELECT ... FROM ${SOURCE_TABLE} ...`,
    "applying the rules. Do not execute anything; this SQL is reviewed by a human first.",
    "",
    "Respond with a SINGLE JSON object and nothing else — no prose, no markdown fences.",
    "The object MUST have exactly these fields:",
    '- "sql": string. The transformation SQL statement described above.',
    '- "targetTable": string. The unqualified marts table name your SQL creates (no schema prefix).',
    '- "assumptions": array of strings. Every assumption you made about the data or the rules.',
    '- "questions": array of strings. Clarifying questions where the rules are ambiguous; [] if none.',
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
    `Source table: ${SOURCE_TABLE}`,
    `- rows: ${profile.rowCount}`,
    `- columns: ${profile.columnCount}`,
    `- candidate keys: ${profile.candidateKeys.length ? profile.candidateKeys.join(", ") : "(none)"}`,
    `- date columns: ${profile.dateColumns.length ? profile.dateColumns.join(", ") : "(none)"}`,
    "- schema:",
    columnLines,
    "",
    "Transformation rules:",
    rules.trim(),
    "",
    "Produce the transformation as the JSON object described above.",
  ].join("\n");

  return { system, prompt };
}

/**
 * Extract the first balanced-looking JSON object from arbitrary model text and parse it. The
 * model may wrap the object in ```json fences or add stray prose, so we take the span from the
 * first `{` to the last `}` and `JSON.parse` it. Throws {@link TransformParseError} when no
 * object is present or the span is not valid JSON.
 */
export function extractJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new TransformParseError("no JSON object found in the model response");
  }
  const slice = text.slice(start, end + 1);
  try {
    return JSON.parse(slice) as unknown;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new TransformParseError(`model response was not valid JSON: ${message}`);
  }
}

/**
 * Parse a model response into a validated {@link Transform}: extract the JSON object, then
 * validate it against {@link TransformSchema}. Throws {@link TransformParseError} — with the
 * failing fields — when the object does not satisfy the contract, so a plausible-but-wrong
 * output (e.g. missing the assumptions the human needs to see) is rejected rather than served.
 */
export function parseTransformResponse(text: string): Transform {
  const json = extractJsonObject(text);
  const parsed = TransformSchema.safeParse(json);
  if (!parsed.success) {
    const summary = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new TransformParseError(
      `model response did not match the transform schema: ${summary}`,
    );
  }
  return parsed.data;
}

// --- Execution (the `run_transform` tool, T4.3 / FR6) -----------------------
//
// After the generated {@link Transform} SQL has been reviewed and approved (FR8), the
// `run_transform` tool executes it, materializing the final business table. That is the
// riskiest tool (it runs arbitrary reviewed SQL), so it is permission `ask`. The pure parts
// below — the target schema and the result shape — mirror {@link file://./warehouse.ts}'s
// load contract; the DuckDB execution itself lives in {@link file://../tools/transform.ts}.

/**
 * The schema `run_transform` materializes into. The transform SQL creates
 * `marts.<targetTable>` (the prompt in {@link buildTransformPrompt} pins this convention), so
 * the tool reads the result back from `marts` to report its row count — which also enforces
 * that the reviewed SQL actually produced the marts table it claimed rather than writing
 * elsewhere.
 */
export const MARTS_SCHEMA = "marts";

/**
 * Result of a successful `run_transform` execution (FR6). Like {@link file://./warehouse.ts}'s
 * `LoadResult`, `rowCount` is read back from the materialized `marts` table (not echoed from
 * the SQL) so it proves the transform actually persisted rows.
 */
export const RunTransformResultSchema = z.object({
  /** Always `marts` — the ELT layer the transform writes its final table into. */
  schema: z.literal(MARTS_SCHEMA),
  /** Sanitized unqualified name of the created marts table. */
  table: z.string().min(1),
  /** Fully-qualified `marts.<table>` name the serving stage reads from. */
  qualifiedTable: z.string().min(1),
  /** Rows in the created table, counted by reading it back. */
  rowCount: z.number().int().nonnegative(),
});
export type RunTransformResult = z.infer<typeof RunTransformResultSchema>;
