import { describe, expect, it, vi } from "vitest";
import { runPlanStage, PlanRuntimeError, type PlanClient } from "./plan.js";
import { PlanParseError } from "../core/plan.js";
import { buildSourceProfile, type SourceProfile } from "../core/profile.js";

/**
 * Integration tests for the plan stage (T3.2, FR3). The only mocked piece is the external,
 * non-deterministic model call (`session.create`/`session.prompt`) — everything else (prompt
 * construction, tool-disabling, response parsing/validation) runs for real. They assert the
 * desired result: a valid model response becomes a validated plan, the prompt disables every
 * write/execute tool, an override model is threaded through, and runtime vs output failures
 * surface as the distinct error types the route maps to 502 vs 422.
 */

const PROFILE: SourceProfile = buildSourceProfile(4, [
  { name: "loan_id", type: "BIGINT", nullCount: 0, distinctCount: 4 },
  { name: "opened_at", type: "DATE", nullCount: 0, distinctCount: 4 },
]);

const PLAN_JSON = JSON.stringify({
  executionPattern: "ELT",
  warehouse: "duckdb",
  partitioning: "Partition landed Parquet by ingestion date.",
  steps: [
    { name: "Extract", description: "Read CSV." },
    { name: "Land Parquet", description: "Write Parquet partitioned by date." },
    { name: "Load Warehouse", description: "Load into raw." },
    { name: "Transform", description: "Apply rules to marts." },
    { name: "DQ Checks", description: "Run checks." },
    { name: "Publish", description: "Serve the table." },
  ],
  summary: "ELT into DuckDB.",
});

/** Build a mock PlanClient whose prompt returns the given text parts (one part per string). */
function mockClient(options: {
  promptTexts?: string[];
  createError?: unknown;
  promptError?: unknown;
  sessionID?: string;
}) {
  const create = vi.fn(async (_opts: unknown) =>
    options.createError
      ? { data: undefined, error: options.createError }
      : { data: { id: options.sessionID ?? "sess-1" }, error: undefined },
  );
  const prompt = vi.fn(async (_opts: unknown) =>
    options.promptError
      ? { data: undefined, error: options.promptError }
      : {
          data: {
            info: {},
            parts: (options.promptTexts ?? [PLAN_JSON]).map((text, i) => ({
              id: `p-${i}`,
              sessionID: "sess-1",
              messageID: "m-1",
              type: "text" as const,
              text,
            })),
          },
          error: undefined,
        },
  );
  const client = { session: { create, prompt } } as unknown as PlanClient;
  return { client, create, prompt };
}

describe("runPlanStage", () => {
  it("returns a validated plan from a valid model response", async () => {
    const { client } = mockClient({ promptTexts: [PLAN_JSON] });
    const plan = await runPlanStage(client, { profile: PROFILE, rules: null });
    expect(plan.executionPattern).toBe("ELT");
    expect(plan.warehouse).toBe("duckdb");
    expect(plan.steps).toHaveLength(6);
  });

  it("prompts the created session with the profile and disables write/execute tools", async () => {
    const { client, prompt } = mockClient({ promptTexts: [PLAN_JSON] });
    await runPlanStage(client, { profile: PROFILE, rules: "Keep active loans." });

    expect(prompt).toHaveBeenCalledOnce();
    const arg = prompt.mock.calls[0]![0] as {
      path: { id: string };
      body: { system: string; tools: Record<string, boolean>; parts: { text: string }[] };
    };
    expect(arg.path.id).toBe("sess-1");
    // The prompt carries the profile and rules.
    expect(arg.body.parts[0]!.text).toContain("loan_id: BIGINT");
    expect(arg.body.parts[0]!.text).toContain("Keep active loans.");
    // Every gated write/execute tool is disabled for the tool-free plan stage.
    for (const tool of ["land_parquet", "load_warehouse", "run_transform", "publish_serving", "bash", "edit"]) {
      expect(arg.body.tools[tool]).toBe(false);
    }
  });

  it("does not set a model when none is given (uses the runtime default)", async () => {
    const { client, prompt } = mockClient({ promptTexts: [PLAN_JSON] });
    await runPlanStage(client, { profile: PROFILE, rules: null });
    const body = (prompt.mock.calls[0]![0] as { body: { model?: unknown } }).body;
    expect(body.model).toBeUndefined();
  });

  it("threads a provider/model override into the prompt body", async () => {
    const { client, prompt } = mockClient({ promptTexts: [PLAN_JSON] });
    await runPlanStage(client, {
      profile: PROFILE,
      rules: null,
      model: "anthropic/claude-opus-4-8",
    });
    const body = (
      prompt.mock.calls[0]![0] as {
        body: { model?: { providerID: string; modelID: string } };
      }
    ).body;
    expect(body.model).toEqual({ providerID: "anthropic", modelID: "claude-opus-4-8" });
  });

  it("joins multiple text parts before parsing", async () => {
    // The plan JSON is split across two text parts; the stage must join them.
    const mid = Math.floor(PLAN_JSON.length / 2);
    const { client } = mockClient({
      promptTexts: [PLAN_JSON.slice(0, mid), PLAN_JSON.slice(mid)],
    });
    const plan = await runPlanStage(client, { profile: PROFILE, rules: null });
    expect(plan.steps).toHaveLength(6);
  });

  it("throws PlanRuntimeError when the session cannot be created", async () => {
    const { client } = mockClient({ createError: { message: "boom" } });
    await expect(runPlanStage(client, { profile: PROFILE, rules: null })).rejects.toBeInstanceOf(
      PlanRuntimeError,
    );
  });

  it("throws PlanRuntimeError when the prompt call errors", async () => {
    const { client } = mockClient({ promptError: { message: "model unavailable" } });
    await expect(runPlanStage(client, { profile: PROFILE, rules: null })).rejects.toBeInstanceOf(
      PlanRuntimeError,
    );
  });

  it("throws PlanParseError when the model output is not a valid plan", async () => {
    const { client } = mockClient({ promptTexts: ["I cannot produce a plan."] });
    await expect(runPlanStage(client, { profile: PROFILE, rules: null })).rejects.toBeInstanceOf(
      PlanParseError,
    );
  });
});
