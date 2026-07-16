import { z } from "zod";
import type { SourceProfile } from "./profile.js";

/**
 * Pure data-quality-generation contract (PRD FR7). The DQ stage prompts the agent to turn the
 * profiled source (plus the transformation rules) into a set of ≥3 reviewable data-quality
 * checks — row count, not-null, schema and freshness — that a human vets before they run. The
 * checks are executed later by the `run_dq_check` tool (T5.1), where **any failure blocks
 * publish** (FR7); this module only generates and validates the spec. As with the plan and
 * transform stages, the OpenCode SDK's `session.prompt` has no native json_schema mode, so
 * "structured output" means: ask the model for one JSON object, then parse and validate it
 * against {@link DqSpecSchema}.
 *
 * This module stays pure (no fs/net/process) so the schema, prompt builder, model-ref splitter
 * and response parser are unit-testable in isolation and reused by the DQ stage
 * ({@link file://../pipeline/dq.ts}), the route and the UI. The extraction and model-ref helpers
 * mirror {@link file://./plan.ts}/{@link file://./transform.ts} on purpose: each stage stays
 * self-contained with its own {@link DqParseError} typing so the route maps a bad *output* to
 * 422 cleanly.
 */

/**
 * The four data-quality check kinds the MVP generates and executes (PRD FR7, ARCHITECTURE §5):
 * - `row_count` — the target table has at least one row (table-level).
 * - `not_null` — a key `column` has no NULLs (column-level; `column` required).
 * - `schema` — an expected `column` is present with its type (a representative column, or the
 *   whole-table shape when `column` is null).
 * - `freshness` — a date `column` is recent / non-null (column-level; `column` required).
 */
export const DQ_CHECK_TYPES = ["row_count", "not_null", "schema", "freshness"] as const;
export type DqCheckType = (typeof DQ_CHECK_TYPES)[number];

/** How many distinct check *types* a valid spec must cover (of the four in {@link DQ_CHECK_TYPES}). */
export const MIN_DISTINCT_CHECK_TYPES = 3;

/** The minimum number of checks a valid spec must contain (PRD §5: "≥3 data-quality checks"). */
export const MIN_DQ_CHECKS = 3;

/** The loaded-source table the generated checks validate — the `raw` table `load_warehouse` writes. */
export const DQ_TARGET_TABLE = "raw.source";

/**
 * One data-quality check the agent proposes. `type` selects which kind of assertion it is;
 * `column` names the column the check applies to (required for `not_null`/`freshness`, since
 * those are inherently column-level, and `null` for a table-level `row_count`). `description`
 * is the human-readable statement of what the check asserts, shown in the review UI. The
 * structured shape (rather than raw SQL) lets the later `run_dq_check` tool (T5.1) translate a
 * check into an executable query deterministically and safely.
 */
export const DqCheckSchema = z
  .object({
    /** Short check name, e.g. "row count is positive". */
    name: z.string().min(1),
    /** Which kind of assertion this check makes. */
    type: z.enum(DQ_CHECK_TYPES),
    /** The column the check applies to; `null` for a table-level check like `row_count`. */
    column: z.string().min(1).nullable(),
    /** Plain-English statement of what the check asserts, for human review. */
    description: z.string().min(1),
  })
  .superRefine((check, ctx) => {
    // not_null and freshness are inherently column-level, so a missing column is a bad check.
    if ((check.type === "not_null" || check.type === "freshness") && !check.column) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `a ${check.type} check requires a column`,
        path: ["column"],
      });
    }
  });
export type DqCheck = z.infer<typeof DqCheckSchema>;

/**
 * The generated data-quality spec (PRD FR7). `targetTable` is the table the checks run against;
 * `checks` is the reviewable set. The invariant the acceptance rubric (LOOP.md §5) requires is
 * enforced here: **at least {@link MIN_DQ_CHECKS} checks covering at least
 * {@link MIN_DISTINCT_CHECK_TYPES} of the four types** — so a degenerate spec of three identical
 * `not_null` checks is rejected rather than passed off as covering "row count, null, schema,
 * freshness". The prompt asks for one of each type, so a well-behaved model produces four.
 */
export const DqSpecSchema = z
  .object({
    /** The table the generated checks validate (the loaded source, {@link DQ_TARGET_TABLE}). */
    targetTable: z.string().min(1),
    /** The reviewable data-quality checks; at least {@link MIN_DQ_CHECKS} are required. */
    checks: z.array(DqCheckSchema).min(MIN_DQ_CHECKS),
  })
  .superRefine((spec, ctx) => {
    const distinct = new Set(spec.checks.map((c) => c.type)).size;
    if (distinct < MIN_DISTINCT_CHECK_TYPES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `checks must cover at least ${MIN_DISTINCT_CHECK_TYPES} distinct types (row_count, not_null, schema, freshness); got ${distinct}`,
        path: ["checks"],
      });
    }
  });
export type DqSpec = z.infer<typeof DqSpecSchema>;

/**
 * The distinct set of check types present in a spec. Exposed so the UI and tests can assert
 * category coverage without re-deriving it from the raw checks.
 */
export function distinctCheckTypes(spec: DqSpec): DqCheckType[] {
  const seen: DqCheckType[] = [];
  for (const check of spec.checks) {
    if (!seen.includes(check.type)) seen.push(check.type);
  }
  return seen;
}

/**
 * Body of `POST /api/projects/:id/dq`. `sourceId` names the source to profile for context
 * (defaults to the project's newest upload, like the plan/transform routes); `model` is an
 * optional `provider/model` per-run override (PRD FR11). Both optional, so the body may be
 * absent entirely.
 */
export const DqRequestSchema = z.object({
  /** Id of the source to profile for check context; defaults to the newest source. */
  sourceId: z.string().min(1).optional(),
  /** `provider/model` override for this run; defaults to the configured free model. */
  model: z.string().min(1).optional(),
});
export type DqRequest = z.infer<typeof DqRequestSchema>;

/**
 * Thrown when the model's response cannot be turned into a valid {@link DqSpec} — no JSON
 * object present, malformed JSON, a bad `provider/model` ref, or a JSON object that fails
 * schema validation (too few checks, too little type coverage, a column-less not_null check).
 * A route maps this to `422 Unprocessable Entity`: the request was fine, the model output was
 * not. Distinct from the pipeline's `DqRuntimeError` (→ 502).
 */
export class DqParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DqParseError";
  }
}

/**
 * Split a `provider/model` ref (e.g. `opencode/big-pickle`) into the `{ providerID, modelID }`
 * shape `session.prompt` expects. Splits on the first `/` so a model id containing slashes is
 * preserved. Throws {@link DqParseError} on a ref missing either half.
 */
export function parseModelRef(ref: string): { providerID: string; modelID: string } {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) {
    throw new DqParseError(`invalid model ref "${ref}" (expected provider/model)`);
  }
  return { providerID: ref.slice(0, slash), modelID: ref.slice(slash + 1) };
}

/**
 * Build the constrained prompt for the DQ stage. Returns a `system` instruction pinning the
 * role, the required JSON-only output shape and the four check types, plus a `prompt` carrying
 * the concrete profiled schema (with candidate keys and date columns the model should key its
 * not_null / freshness checks off) and the rules. Keeping this pure lets a test assert the
 * prompt actually carries the schema, the key/date columns and the rules without a model.
 */
export function buildDqPrompt(input: {
  profile: SourceProfile;
  rules: string | null;
}): { system: string; prompt: string } {
  const { profile, rules } = input;

  const system = [
    "You are a senior data-quality reviewer. Given a profiled CSV source and its optional",
    "transformation rules, propose the data-quality checks a local DuckDB ELT pipeline should",
    `run against the loaded source table ${DQ_TARGET_TABLE} before publishing.`,
    "",
    "Respond with a SINGLE JSON object and nothing else — no prose, no markdown fences.",
    "The object MUST have exactly these fields:",
    `- "targetTable": string. Use "${DQ_TARGET_TABLE}".`,
    '- "checks": array of objects, each { "name": string, "type": string, "column": string|null, "description": string }.',
    "",
    'Each check\'s "type" MUST be one of: "row_count", "not_null", "schema", "freshness".',
    "Generate AT LEAST four checks — one of EACH type:",
    '- "row_count": the table has at least one row. Set "column" to null.',
    '- "not_null": a key column has no NULLs. Set "column" to a candidate-key column.',
    '- "schema": an expected column is present with its type. Set "column" to that column.',
    '- "freshness": a date column is recent / non-null. Set "column" to a date column.',
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
    `Target table: ${DQ_TARGET_TABLE}`,
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
    "Produce the data-quality checks as the JSON object described above.",
  ].join("\n");

  return { system, prompt };
}

/**
 * Extract the first balanced-looking JSON object from arbitrary model text and parse it. The
 * model may wrap the object in ```json fences or add stray prose, so we take the span from the
 * first `{` to the last `}` and `JSON.parse` it. Throws {@link DqParseError} when no object is
 * present or the span is not valid JSON.
 */
export function extractJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new DqParseError("no JSON object found in the model response");
  }
  const slice = text.slice(start, end + 1);
  try {
    return JSON.parse(slice) as unknown;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new DqParseError(`model response was not valid JSON: ${message}`);
  }
}

/**
 * Parse a model response into a validated {@link DqSpec}: extract the JSON object, then validate
 * it against {@link DqSpecSchema}. Throws {@link DqParseError} — with the failing fields — when
 * the object does not satisfy the contract, so a plausible-but-wrong output (too few checks, no
 * type coverage, a column-less not_null) is rejected rather than served (LOOP.md §5).
 */
export function parseDqResponse(text: string): DqSpec {
  const json = extractJsonObject(text);
  const parsed = DqSpecSchema.safeParse(json);
  if (!parsed.success) {
    const summary = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new DqParseError(`model response did not match the DQ schema: ${summary}`);
  }
  return parsed.data;
}
