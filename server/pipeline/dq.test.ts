import { describe, expect, it, vi } from "vitest";
import { runDqStage, DqRuntimeError, type DqClient } from "./dq.js";
import { DqParseError, DQ_TARGET_TABLE } from "../core/dq.js";
import { buildSourceProfile, type SourceProfile } from "../core/profile.js";

/**
 * Integration tests for the DQ stage (T3.4, FR7). The only mocked piece is the external,
 * non-deterministic model call (`session.create`/`session.prompt`) — everything else (prompt
 * construction, tool-disabling, response parsing/validation) runs for real. They assert the
 * desired result: a valid model response becomes a validated ≥3-check spec, the prompt disables
 * every write/execute tool and carries the profile, an override model is threaded through, and
 * runtime vs output failures surface as the distinct error types the route maps to 502 vs 422.
 */

const PROFILE: SourceProfile = buildSourceProfile(4, [
  { name: "loan_id", type: "BIGINT", nullCount: 0, distinctCount: 4 },
  { name: "branch", type: "VARCHAR", nullCount: 0, distinctCount: 2 },
  { name: "opened_at", type: "DATE", nullCount: 0, distinctCount: 4 },
]);

const DQ_JSON = JSON.stringify({
  targetTable: DQ_TARGET_TABLE,
  checks: [
    { name: "rows present", type: "row_count", column: null, description: "at least one row" },
    { name: "id not null", type: "not_null", column: "loan_id", description: "loan_id never null" },
    { name: "branch present", type: "schema", column: "branch", description: "branch column exists" },
    { name: "recent", type: "freshness", column: "opened_at", description: "opened_at is recent" },
  ],
});

/** Build a mock DqClient whose prompt returns the given text parts (one part per string). */
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
            parts: (options.promptTexts ?? [DQ_JSON]).map((text, i) => ({
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
  const client = { session: { create, prompt } } as unknown as DqClient;
  return { client, create, prompt };
}

describe("runDqStage", () => {
  it("returns a validated ≥3-check spec from a valid model response", async () => {
    const { client } = mockClient({ promptTexts: [DQ_JSON] });
    const spec = await runDqStage(client, { profile: PROFILE, rules: "Aggregate by branch." });
    expect(spec.targetTable).toBe(DQ_TARGET_TABLE);
    expect(spec.checks.length).toBeGreaterThanOrEqual(3);
    expect(new Set(spec.checks.map((c) => c.type)).size).toBeGreaterThanOrEqual(3);
  });

  it("prompts the created session with the profile and disables write/execute tools", async () => {
    const { client, prompt } = mockClient({ promptTexts: [DQ_JSON] });
    await runDqStage(client, { profile: PROFILE, rules: null });

    expect(prompt).toHaveBeenCalledOnce();
    const arg = prompt.mock.calls[0]![0] as {
      path: { id: string };
      body: { system: string; tools: Record<string, boolean>; parts: { text: string }[] };
    };
    expect(arg.path.id).toBe("sess-1");
    expect(arg.body.parts[0]!.text).toContain("loan_id: BIGINT");
    for (const tool of ["land_parquet", "load_warehouse", "run_transform", "publish_serving", "bash", "edit"]) {
      expect(arg.body.tools[tool]).toBe(false);
    }
  });

  it("does not set a model when none is given (uses the runtime default)", async () => {
    const { client, prompt } = mockClient({ promptTexts: [DQ_JSON] });
    await runDqStage(client, { profile: PROFILE, rules: null });
    const body = (prompt.mock.calls[0]![0] as { body: { model?: unknown } }).body;
    expect(body.model).toBeUndefined();
  });

  it("threads a provider/model override into the prompt body", async () => {
    const { client, prompt } = mockClient({ promptTexts: [DQ_JSON] });
    await runDqStage(client, {
      profile: PROFILE,
      rules: null,
      model: "anthropic/claude-opus-4-8",
    });
    const body = (
      prompt.mock.calls[0]![0] as { body: { model?: { providerID: string; modelID: string } } }
    ).body;
    expect(body.model).toEqual({ providerID: "anthropic", modelID: "claude-opus-4-8" });
  });

  it("joins multiple text parts before parsing", async () => {
    const mid = Math.floor(DQ_JSON.length / 2);
    const { client } = mockClient({ promptTexts: [DQ_JSON.slice(0, mid), DQ_JSON.slice(mid)] });
    const spec = await runDqStage(client, { profile: PROFILE, rules: null });
    expect(spec.checks).toHaveLength(4);
  });

  it("throws DqRuntimeError when the session cannot be created", async () => {
    const { client } = mockClient({ createError: { message: "boom" } });
    await expect(runDqStage(client, { profile: PROFILE, rules: null })).rejects.toBeInstanceOf(
      DqRuntimeError,
    );
  });

  it("throws DqRuntimeError when the prompt call errors", async () => {
    const { client } = mockClient({ promptError: { message: "model unavailable" } });
    await expect(runDqStage(client, { profile: PROFILE, rules: null })).rejects.toBeInstanceOf(
      DqRuntimeError,
    );
  });

  it("throws DqParseError when the model output is not a valid spec", async () => {
    const { client } = mockClient({ promptTexts: ["I cannot produce checks."] });
    await expect(runDqStage(client, { profile: PROFILE, rules: null })).rejects.toBeInstanceOf(
      DqParseError,
    );
  });

  it("throws DqParseError when the spec has too few checks", async () => {
    const tooFew = JSON.stringify({
      targetTable: DQ_TARGET_TABLE,
      checks: [{ name: "rows", type: "row_count", column: null, description: "rows present" }],
    });
    const { client } = mockClient({ promptTexts: [tooFew] });
    await expect(runDqStage(client, { profile: PROFILE, rules: null })).rejects.toBeInstanceOf(
      DqParseError,
    );
  });
});
