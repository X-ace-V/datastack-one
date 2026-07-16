import { describe, expect, it } from "vitest";
import {
  buildDqPrompt,
  DQ_CHECK_TYPES,
  DQ_TARGET_TABLE,
  distinctCheckTypes,
  DqParseError,
  DqSpecSchema,
  extractJsonObject,
  MIN_DISTINCT_CHECK_TYPES,
  MIN_DQ_CHECKS,
  parseDqResponse,
  parseModelRef,
} from "./dq.js";
import { buildSourceProfile, type SourceProfile } from "./profile.js";

/**
 * Unit tests for the pure DQ-generation contract (T3.4, FR7). They assert the desired result:
 * the schema accepts a well-formed ≥3-check spec covering the four types and *rejects* the
 * plausible-but-wrong ones (too few checks, too little type coverage, a column-less not_null),
 * the prompt carries the profile + key/date columns + rules + the four check types, and the
 * response parser tolerates fences/prose while mapping a bad output to a `DqParseError`.
 */

const PROFILE: SourceProfile = buildSourceProfile(4, [
  { name: "loan_id", type: "BIGINT", nullCount: 0, distinctCount: 4 },
  { name: "branch", type: "VARCHAR", nullCount: 0, distinctCount: 2 },
  { name: "balance", type: "DOUBLE", nullCount: 1, distinctCount: 3 },
  { name: "opened_at", type: "DATE", nullCount: 0, distinctCount: 4 },
]);

/** A valid spec covering all four check types. */
const VALID_SPEC = {
  targetTable: DQ_TARGET_TABLE,
  checks: [
    { name: "rows present", type: "row_count", column: null, description: "at least one row" },
    { name: "id not null", type: "not_null", column: "loan_id", description: "loan_id never null" },
    { name: "branch present", type: "schema", column: "branch", description: "branch column exists" },
    { name: "recent data", type: "freshness", column: "opened_at", description: "opened_at is recent" },
  ],
};

describe("DqSpecSchema", () => {
  it("accepts a well-formed spec covering the four check types", () => {
    const parsed = DqSpecSchema.parse(VALID_SPEC);
    expect(parsed.checks).toHaveLength(4);
    expect(distinctCheckTypes(parsed)).toEqual([...DQ_CHECK_TYPES]);
  });

  it("rejects a spec with fewer than the minimum number of checks", () => {
    const spec = { targetTable: DQ_TARGET_TABLE, checks: VALID_SPEC.checks.slice(0, MIN_DQ_CHECKS - 1) };
    expect(DqSpecSchema.safeParse(spec).success).toBe(false);
  });

  it("rejects a spec that covers too few distinct check types", () => {
    // Three checks, but all of them not_null → only one distinct type.
    const spec = {
      targetTable: DQ_TARGET_TABLE,
      checks: [
        { name: "a", type: "not_null", column: "loan_id", description: "loan_id not null" },
        { name: "b", type: "not_null", column: "branch", description: "branch not null" },
        { name: "c", type: "not_null", column: "opened_at", description: "opened_at not null" },
      ],
    };
    const result = DqSpecSchema.safeParse(spec);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes("distinct types"))).toBe(true);
    }
  });

  it("requires exactly the coverage threshold to be a policy, not a magic number", () => {
    expect(MIN_DISTINCT_CHECK_TYPES).toBe(3);
    // A spec with exactly three distinct types passes.
    const spec = {
      targetTable: DQ_TARGET_TABLE,
      checks: VALID_SPEC.checks.slice(0, 3),
    };
    expect(DqSpecSchema.safeParse(spec).success).toBe(true);
    expect(distinctCheckTypes(DqSpecSchema.parse(spec))).toHaveLength(3);
  });

  it("rejects a not_null check with no column", () => {
    const spec = {
      targetTable: DQ_TARGET_TABLE,
      checks: [
        { name: "rows", type: "row_count", column: null, description: "rows present" },
        { name: "schema", type: "schema", column: "branch", description: "branch exists" },
        { name: "bad", type: "not_null", column: null, description: "missing column" },
      ],
    };
    expect(DqSpecSchema.safeParse(spec).success).toBe(false);
  });

  it("rejects a freshness check with no column", () => {
    const spec = {
      targetTable: DQ_TARGET_TABLE,
      checks: [
        { name: "rows", type: "row_count", column: null, description: "rows present" },
        { name: "schema", type: "schema", column: "branch", description: "branch exists" },
        { name: "bad", type: "freshness", column: null, description: "no date column" },
      ],
    };
    expect(DqSpecSchema.safeParse(spec).success).toBe(false);
  });

  it("rejects an unknown check type", () => {
    const spec = {
      targetTable: DQ_TARGET_TABLE,
      checks: [
        { name: "rows", type: "row_count", column: null, description: "rows present" },
        { name: "schema", type: "schema", column: "branch", description: "branch exists" },
        { name: "weird", type: "uniqueness", column: "loan_id", description: "unsupported" },
      ],
    };
    expect(DqSpecSchema.safeParse(spec).success).toBe(false);
  });

  it("allows a row_count check with a null column (table-level)", () => {
    const spec = {
      targetTable: DQ_TARGET_TABLE,
      checks: [
        { name: "rows", type: "row_count", column: null, description: "rows present" },
        { name: "id", type: "not_null", column: "loan_id", description: "id not null" },
        { name: "schema", type: "schema", column: "branch", description: "branch exists" },
      ],
    };
    expect(DqSpecSchema.safeParse(spec).success).toBe(true);
  });
});

describe("distinctCheckTypes", () => {
  it("returns the distinct types in first-seen order without duplicates", () => {
    const spec = DqSpecSchema.parse({
      targetTable: DQ_TARGET_TABLE,
      checks: [
        { name: "a", type: "not_null", column: "loan_id", description: "id not null" },
        { name: "b", type: "row_count", column: null, description: "rows present" },
        { name: "c", type: "not_null", column: "branch", description: "branch not null" },
        { name: "d", type: "schema", column: "branch", description: "branch exists" },
      ],
    });
    expect(distinctCheckTypes(spec)).toEqual(["not_null", "row_count", "schema"]);
  });
});

describe("parseModelRef", () => {
  it("splits provider/model on the first slash", () => {
    expect(parseModelRef("anthropic/claude-opus-4-8")).toEqual({
      providerID: "anthropic",
      modelID: "claude-opus-4-8",
    });
  });

  it("throws DqParseError on a ref missing a half", () => {
    expect(() => parseModelRef("nope")).toThrow(DqParseError);
    expect(() => parseModelRef("/model")).toThrow(DqParseError);
    expect(() => parseModelRef("provider/")).toThrow(DqParseError);
  });
});

describe("buildDqPrompt", () => {
  it("carries the profile, candidate keys, date columns and the target table", () => {
    const { system, prompt } = buildDqPrompt({ profile: PROFILE, rules: null });
    // The four check types are pinned in the system instruction.
    for (const type of DQ_CHECK_TYPES) {
      expect(system).toContain(type);
    }
    expect(system).toContain(DQ_TARGET_TABLE);
    // The prompt carries the concrete schema, keys and date columns the checks key off.
    expect(prompt).toContain("loan_id: BIGINT");
    expect(prompt).toContain("opened_at: DATE");
    expect(prompt).toContain("candidate keys: loan_id, opened_at");
    expect(prompt).toContain("date columns: opened_at");
    expect(prompt).toContain("(none provided)");
  });

  it("includes the rules text when rules are provided", () => {
    const { prompt } = buildDqPrompt({ profile: PROFILE, rules: "  Aggregate balance by branch.  " });
    expect(prompt).toContain("Aggregate balance by branch.");
    expect(prompt).not.toContain("(none provided)");
  });
});

describe("extractJsonObject", () => {
  it("extracts an object wrapped in ```json fences and prose", () => {
    const text = "Here are the checks:\n```json\n" + JSON.stringify(VALID_SPEC) + "\n```\nDone.";
    expect(extractJsonObject(text)).toMatchObject({ targetTable: DQ_TARGET_TABLE });
  });

  it("throws DqParseError when there is no object", () => {
    expect(() => extractJsonObject("no json here")).toThrow(DqParseError);
  });

  it("throws DqParseError when the span is not valid JSON", () => {
    expect(() => extractJsonObject("{ not: valid }")).toThrow(DqParseError);
  });
});

describe("parseDqResponse", () => {
  it("parses and validates a fenced valid spec", () => {
    const text = "```json\n" + JSON.stringify(VALID_SPEC) + "\n```";
    const spec = parseDqResponse(text);
    expect(spec.checks).toHaveLength(4);
    expect(spec.targetTable).toBe(DQ_TARGET_TABLE);
  });

  it("throws DqParseError when the object fails the schema", () => {
    const text = JSON.stringify({ targetTable: DQ_TARGET_TABLE, checks: VALID_SPEC.checks.slice(0, 1) });
    expect(() => parseDqResponse(text)).toThrow(DqParseError);
  });
});
