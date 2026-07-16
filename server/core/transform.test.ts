import { describe, expect, it } from "vitest";
import {
  TransformSchema,
  TransformParseError,
  buildTransformPrompt,
  extractJsonObject,
  parseModelRef,
  parseTransformResponse,
  RunTransformResultSchema,
  MARTS_SCHEMA,
  SOURCE_TABLE,
} from "./transform.js";
import { buildSourceProfile, type SourceProfile } from "./profile.js";

/**
 * Pure unit tests for the transform contract (T3.3, FR6). They assert the desired result — the
 * schema rejects a transform missing its SQL or its surfaced assumptions/questions, the prompt
 * carries the profile + rules + the raw→marts convention, and the parser turns real-ish model
 * text into a validated transform while rejecting plausible-but-wrong output (LOOP.md §5). No
 * model, no I/O.
 */

const PROFILE: SourceProfile = buildSourceProfile(4, [
  { name: "loan_id", type: "BIGINT", nullCount: 0, distinctCount: 4 },
  { name: "balance", type: "DOUBLE", nullCount: 1, distinctCount: 3 },
  { name: "opened_at", type: "DATE", nullCount: 0, distinctCount: 4 },
]);

const VALID_TRANSFORM = {
  sql: "CREATE OR REPLACE TABLE marts.loan_summary AS SELECT branch, sum(balance) AS total FROM raw.source GROUP BY branch;",
  targetTable: "loan_summary",
  assumptions: ["A null balance is treated as zero."],
  questions: ["Should closed loans be excluded?"],
};

describe("TransformSchema", () => {
  it("accepts a complete transform", () => {
    expect(TransformSchema.parse(VALID_TRANSFORM)).toMatchObject({
      targetTable: "loan_summary",
    });
    expect(TransformSchema.parse(VALID_TRANSFORM).assumptions).toHaveLength(1);
  });

  it("rejects a transform with empty SQL", () => {
    expect(TransformSchema.safeParse({ ...VALID_TRANSFORM, sql: "" }).success).toBe(false);
  });

  it("rejects a transform missing the target table", () => {
    const { targetTable: _omit, ...rest } = VALID_TRANSFORM;
    expect(TransformSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects a transform missing the assumptions field", () => {
    const { assumptions: _omit, ...rest } = VALID_TRANSFORM;
    expect(TransformSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects a transform missing the questions field", () => {
    const { questions: _omit, ...rest } = VALID_TRANSFORM;
    expect(TransformSchema.safeParse(rest).success).toBe(false);
  });

  it("accepts empty assumptions/questions arrays (nothing to surface)", () => {
    expect(
      TransformSchema.safeParse({ ...VALID_TRANSFORM, assumptions: [], questions: [] }).success,
    ).toBe(true);
  });
});

describe("parseModelRef", () => {
  it("splits a provider/model ref", () => {
    expect(parseModelRef("opencode/big-pickle")).toEqual({
      providerID: "opencode",
      modelID: "big-pickle",
    });
  });

  it("splits on the first slash so model ids may contain slashes", () => {
    expect(parseModelRef("openrouter/meta/llama")).toEqual({
      providerID: "openrouter",
      modelID: "meta/llama",
    });
  });

  it("throws TransformParseError on a ref with no provider", () => {
    expect(() => parseModelRef("big-pickle")).toThrow(TransformParseError);
  });

  it("throws TransformParseError on a trailing-slash ref", () => {
    expect(() => parseModelRef("opencode/")).toThrow(TransformParseError);
  });
});

describe("buildTransformPrompt", () => {
  it("pins the JSON-only contract and the raw→marts convention in the system message", () => {
    const { system } = buildTransformPrompt({ profile: PROFILE, rules: "Keep active loans." });
    expect(system).toMatch(/SINGLE JSON object/);
    expect(system).toContain(SOURCE_TABLE);
    expect(system).toMatch(/CREATE OR REPLACE TABLE marts/);
    // The four required output fields are all named.
    for (const field of ["sql", "targetTable", "assumptions", "questions"]) {
      expect(system).toContain(`"${field}"`);
    }
  });

  it("carries the profiled schema and the rules into the prompt", () => {
    const { prompt } = buildTransformPrompt({
      profile: PROFILE,
      rules: "Aggregate balance by branch.",
    });
    expect(prompt).toContain(`Source table: ${SOURCE_TABLE}`);
    expect(prompt).toContain("rows: 4");
    expect(prompt).toContain("loan_id: BIGINT");
    expect(prompt).toMatch(/opened_at: DATE.*\(date\)/);
    expect(prompt).toContain("Aggregate balance by branch.");
  });

  it("trims the rules text", () => {
    const { prompt } = buildTransformPrompt({
      profile: PROFILE,
      rules: "\n\n  Keep active loans.  \n",
    });
    expect(prompt).toContain("Keep active loans.");
    expect(prompt).not.toMatch(/rules:\n\n\n/);
  });
});

describe("extractJsonObject", () => {
  it("parses a bare JSON object", () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
  });

  it("parses an object wrapped in a markdown fence with prose", () => {
    const text = 'Here is the SQL:\n```json\n{"sql":"SELECT 1","a":[2]}\n```\nThanks!';
    expect(extractJsonObject(text)).toEqual({ sql: "SELECT 1", a: [2] });
  });

  it("throws TransformParseError when no object is present", () => {
    expect(() => extractJsonObject("no json here")).toThrow(TransformParseError);
  });

  it("throws TransformParseError on malformed JSON", () => {
    expect(() => extractJsonObject("{not valid}")).toThrow(TransformParseError);
  });
});

describe("parseTransformResponse", () => {
  it("validates a fenced transform into a Transform", () => {
    const text = "```json\n" + JSON.stringify(VALID_TRANSFORM) + "\n```";
    const transform = parseTransformResponse(text);
    expect(transform.targetTable).toBe("loan_summary");
    expect(transform.sql).toContain("marts.loan_summary");
    expect(transform.assumptions).toHaveLength(1);
    expect(transform.questions).toHaveLength(1);
  });

  it("parses a transform surrounded by prose", () => {
    const text = `The transformation is:\n${JSON.stringify(VALID_TRANSFORM)}\nDone.`;
    expect(parseTransformResponse(text).targetTable).toBe("loan_summary");
  });

  it("rejects valid JSON that is not a valid transform", () => {
    const text = JSON.stringify({ sql: "SELECT 1", targetTable: "x" });
    expect(() => parseTransformResponse(text)).toThrow(TransformParseError);
  });

  it("rejects an empty-SQL transform and names the failing field", () => {
    const text = JSON.stringify({ ...VALID_TRANSFORM, sql: "" });
    expect(() => parseTransformResponse(text)).toThrow(/sql/);
  });

  it("rejects non-JSON model chatter", () => {
    expect(() => parseTransformResponse("I could not produce SQL.")).toThrow(
      TransformParseError,
    );
  });
});

describe("RunTransformResultSchema (run_transform execution contract)", () => {
  const VALID_RESULT = {
    schema: MARTS_SCHEMA,
    table: "branch_balance_totals",
    qualifiedTable: "marts.branch_balance_totals",
    rowCount: 2,
  };

  it("accepts a complete marts result", () => {
    expect(RunTransformResultSchema.parse(VALID_RESULT)).toEqual(VALID_RESULT);
  });

  it("pins the schema to marts (run_transform never writes elsewhere)", () => {
    expect(MARTS_SCHEMA).toBe("marts");
    expect(RunTransformResultSchema.safeParse({ ...VALID_RESULT, schema: "raw" }).success).toBe(
      false,
    );
  });

  it("rejects an empty table name", () => {
    expect(RunTransformResultSchema.safeParse({ ...VALID_RESULT, table: "" }).success).toBe(false);
  });

  it("rejects a negative or fractional row count", () => {
    expect(RunTransformResultSchema.safeParse({ ...VALID_RESULT, rowCount: -1 }).success).toBe(
      false,
    );
    expect(RunTransformResultSchema.safeParse({ ...VALID_RESULT, rowCount: 1.5 }).success).toBe(
      false,
    );
  });
});
