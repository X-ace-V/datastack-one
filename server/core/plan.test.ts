import { describe, expect, it } from "vitest";
import {
  PlanSchema,
  PlanParseError,
  buildPlanPrompt,
  extractJsonObject,
  parseModelRef,
  parsePlanResponse,
} from "./plan.js";
import { buildSourceProfile, type SourceProfile } from "./profile.js";

/**
 * Pure unit tests for the plan contract (T3.2, FR3). They assert the desired result — the
 * schema rejects an incomplete plan, the prompt actually carries the profile + the ELT/DuckDB
 * contract, and the parser turns real-ish model text into a validated plan while rejecting
 * plausible-but-wrong output (LOOP.md §5). No model, no I/O.
 */

const PROFILE: SourceProfile = buildSourceProfile(4, [
  { name: "loan_id", type: "BIGINT", nullCount: 0, distinctCount: 4 },
  { name: "balance", type: "DOUBLE", nullCount: 1, distinctCount: 3 },
  { name: "opened_at", type: "DATE", nullCount: 0, distinctCount: 4 },
]);

const VALID_PLAN = {
  executionPattern: "ELT",
  warehouse: "duckdb",
  partitioning: "Partition landed Parquet by ingestion date.",
  steps: [
    { name: "Extract", description: "Read the uploaded CSV." },
    { name: "Land Parquet", description: "Write raw rows to landing partitioned by date." },
    { name: "Load Warehouse", description: "Load Parquet into raw." },
    { name: "Transform", description: "Apply rules into marts." },
    { name: "DQ Checks", description: "Run data-quality checks." },
    { name: "Publish", description: "Serve the final table." },
  ],
  summary: "An ELT pipeline landing to Parquet then loading DuckDB.",
};

describe("PlanSchema", () => {
  it("accepts a complete plan", () => {
    expect(PlanSchema.parse(VALID_PLAN)).toMatchObject({
      executionPattern: "ELT",
      warehouse: "duckdb",
    });
    expect(PlanSchema.parse(VALID_PLAN).steps).toHaveLength(6);
  });

  it("rejects a plan missing the execution pattern", () => {
    const { executionPattern: _omit, ...rest } = VALID_PLAN;
    expect(PlanSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects a plan with an empty step list", () => {
    expect(PlanSchema.safeParse({ ...VALID_PLAN, steps: [] }).success).toBe(false);
  });

  it("rejects a step missing its description", () => {
    const steps = [{ name: "Extract" }];
    expect(PlanSchema.safeParse({ ...VALID_PLAN, steps }).success).toBe(false);
  });

  it("treats the summary as optional", () => {
    const { summary: _omit, ...rest } = VALID_PLAN;
    expect(PlanSchema.safeParse(rest).success).toBe(true);
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

  it("throws on a ref with no provider", () => {
    expect(() => parseModelRef("big-pickle")).toThrow(PlanParseError);
  });

  it("throws on a trailing-slash ref", () => {
    expect(() => parseModelRef("opencode/")).toThrow(PlanParseError);
  });
});

describe("buildPlanPrompt", () => {
  it("pins the JSON-only contract and required values in the system message", () => {
    const { system } = buildPlanPrompt({ profile: PROFILE, rules: null });
    expect(system).toMatch(/SINGLE JSON object/);
    expect(system).toContain("ELT");
    expect(system).toContain("duckdb");
    expect(system).toMatch(/ingestion date/i);
    // Names all six pipeline stages the plan must cover.
    for (const stage of ["Extract", "Land Parquet", "Load Warehouse", "Transform", "DQ Checks", "Publish"]) {
      expect(system).toContain(stage);
    }
  });

  it("carries the profiled schema and row count into the prompt", () => {
    const { prompt } = buildPlanPrompt({ profile: PROFILE, rules: null });
    expect(prompt).toContain("rows: 4");
    expect(prompt).toContain("loan_id: BIGINT");
    expect(prompt).toMatch(/opened_at: DATE.*\(date\)/);
    expect(prompt).toContain("candidate keys: loan_id, opened_at");
    expect(prompt).toContain("(none provided)");
  });

  it("includes the transformation rules when present", () => {
    const { prompt } = buildPlanPrompt({
      profile: PROFILE,
      rules: "Keep only active loans.",
    });
    expect(prompt).toContain("Keep only active loans.");
    expect(prompt).not.toContain("(none provided)");
  });
});

describe("extractJsonObject", () => {
  it("parses a bare JSON object", () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
  });

  it("parses an object wrapped in a markdown fence with prose", () => {
    const text = 'Here is the plan:\n```json\n{"a":1,"b":[2]}\n```\nThanks!';
    expect(extractJsonObject(text)).toEqual({ a: 1, b: [2] });
  });

  it("throws when no object is present", () => {
    expect(() => extractJsonObject("no json here")).toThrow(PlanParseError);
  });

  it("throws on malformed JSON", () => {
    expect(() => extractJsonObject("{not valid}")).toThrow(PlanParseError);
  });
});

describe("parsePlanResponse", () => {
  it("validates a fenced plan into a Plan", () => {
    const text = "```json\n" + JSON.stringify(VALID_PLAN) + "\n```";
    const plan = parsePlanResponse(text);
    expect(plan.executionPattern).toBe("ELT");
    expect(plan.warehouse).toBe("duckdb");
    expect(plan.steps).toHaveLength(6);
  });

  it("parses a plan surrounded by prose", () => {
    const text = `The architecture plan is:\n${JSON.stringify(VALID_PLAN)}\nDone.`;
    expect(parsePlanResponse(text).steps[0]?.name).toBe("Extract");
  });

  it("rejects valid JSON that is not a valid plan", () => {
    const text = JSON.stringify({ executionPattern: "ELT", warehouse: "duckdb" });
    expect(() => parsePlanResponse(text)).toThrow(PlanParseError);
  });

  it("rejects a plan with no steps and names the failing field", () => {
    const text = JSON.stringify({ ...VALID_PLAN, steps: [] });
    expect(() => parsePlanResponse(text)).toThrow(/steps/);
  });

  it("rejects non-JSON model chatter", () => {
    expect(() => parsePlanResponse("I could not produce a plan.")).toThrow(PlanParseError);
  });
});
