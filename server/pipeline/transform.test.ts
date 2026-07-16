import { describe, expect, it, vi } from "vitest";
import {
  runTransformStage,
  TransformRuntimeError,
  type TransformClient,
} from "./transform.js";
import { TransformParseError } from "../core/transform.js";
import { buildSourceProfile, type SourceProfile } from "../core/profile.js";

/**
 * Integration tests for the transform stage (T3.3, FR6). The only mocked piece is the external,
 * non-deterministic model call (`session.create`/`session.prompt`) — everything else (prompt
 * construction, tool-disabling, response parsing/validation) runs for real. They assert the
 * desired result: a valid model response becomes a validated transform, the prompt disables
 * every write/execute tool and carries the rules, an override model is threaded through, and
 * runtime vs output failures surface as the distinct error types the route maps to 502 vs 422.
 */

const PROFILE: SourceProfile = buildSourceProfile(4, [
  { name: "loan_id", type: "BIGINT", nullCount: 0, distinctCount: 4 },
  { name: "branch", type: "VARCHAR", nullCount: 0, distinctCount: 2 },
  { name: "balance", type: "DOUBLE", nullCount: 1, distinctCount: 3 },
]);

const TRANSFORM_JSON = JSON.stringify({
  sql: "CREATE OR REPLACE TABLE marts.loan_summary AS SELECT branch, sum(balance) AS total FROM raw.source GROUP BY branch;",
  targetTable: "loan_summary",
  assumptions: ["A null balance is treated as zero."],
  questions: [],
});

/** Build a mock TransformClient whose prompt returns the given text parts (one part per string). */
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
            parts: (options.promptTexts ?? [TRANSFORM_JSON]).map((text, i) => ({
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
  const client = { session: { create, prompt } } as unknown as TransformClient;
  return { client, create, prompt };
}

describe("runTransformStage", () => {
  it("returns a validated transform from a valid model response", async () => {
    const { client } = mockClient({ promptTexts: [TRANSFORM_JSON] });
    const transform = await runTransformStage(client, { profile: PROFILE, rules: "Sum by branch." });
    expect(transform.targetTable).toBe("loan_summary");
    expect(transform.sql).toContain("marts.loan_summary");
    expect(transform.assumptions).toHaveLength(1);
    expect(transform.questions).toEqual([]);
  });

  it("prompts the created session with the rules and disables write/execute tools", async () => {
    const { client, prompt } = mockClient({ promptTexts: [TRANSFORM_JSON] });
    await runTransformStage(client, { profile: PROFILE, rules: "Aggregate balance by branch." });

    expect(prompt).toHaveBeenCalledOnce();
    const arg = prompt.mock.calls[0]![0] as {
      path: { id: string };
      body: { system: string; tools: Record<string, boolean>; parts: { text: string }[] };
    };
    expect(arg.path.id).toBe("sess-1");
    // The prompt carries the profile and the rules text.
    expect(arg.body.parts[0]!.text).toContain("branch: VARCHAR");
    expect(arg.body.parts[0]!.text).toContain("Aggregate balance by branch.");
    // Every gated write/execute tool is disabled for the tool-free transform stage.
    for (const tool of ["land_parquet", "load_warehouse", "run_transform", "publish_serving", "bash", "edit"]) {
      expect(arg.body.tools[tool]).toBe(false);
    }
  });

  it("does not set a model when none is given (uses the runtime default)", async () => {
    const { client, prompt } = mockClient({ promptTexts: [TRANSFORM_JSON] });
    await runTransformStage(client, { profile: PROFILE, rules: "Sum by branch." });
    const body = (prompt.mock.calls[0]![0] as { body: { model?: unknown } }).body;
    expect(body.model).toBeUndefined();
  });

  it("threads a provider/model override into the prompt body", async () => {
    const { client, prompt } = mockClient({ promptTexts: [TRANSFORM_JSON] });
    await runTransformStage(client, {
      profile: PROFILE,
      rules: "Sum by branch.",
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
    const mid = Math.floor(TRANSFORM_JSON.length / 2);
    const { client } = mockClient({
      promptTexts: [TRANSFORM_JSON.slice(0, mid), TRANSFORM_JSON.slice(mid)],
    });
    const transform = await runTransformStage(client, { profile: PROFILE, rules: "Sum by branch." });
    expect(transform.targetTable).toBe("loan_summary");
  });

  it("throws TransformRuntimeError when the session cannot be created", async () => {
    const { client } = mockClient({ createError: { message: "boom" } });
    await expect(
      runTransformStage(client, { profile: PROFILE, rules: "Sum by branch." }),
    ).rejects.toBeInstanceOf(TransformRuntimeError);
  });

  it("throws TransformRuntimeError when the prompt call errors", async () => {
    const { client } = mockClient({ promptError: { message: "model unavailable" } });
    await expect(
      runTransformStage(client, { profile: PROFILE, rules: "Sum by branch." }),
    ).rejects.toBeInstanceOf(TransformRuntimeError);
  });

  it("throws TransformParseError when the model output is not a valid transform", async () => {
    const { client } = mockClient({ promptTexts: ["I cannot produce SQL."] });
    await expect(
      runTransformStage(client, { profile: PROFILE, rules: "Sum by branch." }),
    ).rejects.toBeInstanceOf(TransformParseError);
  });
});
