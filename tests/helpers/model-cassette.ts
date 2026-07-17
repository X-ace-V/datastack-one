import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { OpencodeClient } from "@opencode-ai/sdk";
import type { PlanClient } from "../../server/pipeline/plan.js";

/**
 * Recorded model responses ("cassettes") for the PRD §5 acceptance test (T6.2).
 *
 * The acceptance flow has exactly one non-deterministic, off-machine dependency: the three
 * generation stages that prompt a model (plan, transform, DQ). Everything else — the routes, the
 * tools, DuckDB, the approval gate, the runner, the serving layer — is deterministic and runs for
 * real. Putting a live model call inside `npm test` would make the build loop's gate depend on a
 * free model's availability and mood, so the default mode **replays** responses the free model
 * genuinely produced against the committed fixture, while every other layer executes for real.
 *
 * The recordings are not hand-written stand-ins: {@link recordingStage} captures them from a live
 * `opencode/big-pickle` run (`ACCEPTANCE_LIVE_MODEL=1`), so the SQL the acceptance test executes is
 * the SQL the free model actually wrote for `fixtures/loans_sample.csv`. Each cassette carries the
 * model ref and observed latency that produced it, which is the provenance PRD §5's "runs on
 * `opencode/big-pickle` (free)" criterion is asserted against when replaying.
 *
 * Test-only: this module is never imported by `server/`.
 */

/** Directory the cassettes live in. Committed — they are synthetic-fixture-derived, not real data. */
export const CASSETTE_DIR = fileURLToPath(
  new URL("../fixtures/model-responses/", import.meta.url),
);

/** The three pipeline stages that prompt a model, each with its own cassette. */
export const GENERATION_STAGES = ["plan", "transform", "dq"] as const;
export type GenerationStage = (typeof GENERATION_STAGES)[number];

/** A model ref as the SDK takes it on the wire, split by `parseModelRef`. */
const ModelRefSchema = z.object({
  providerID: z.string().min(1),
  modelID: z.string().min(1),
});
export type ModelRef = z.infer<typeof ModelRefSchema>;

/** One stage's recorded live model response, with the provenance that makes it evidence. */
export const StageRecordingSchema = z.object({
  /** The stage whose prompt produced this response. */
  stage: z.enum(GENERATION_STAGES),
  /** The `provider/model` ref that generated it — PRD §5 asserts this is the free model. */
  model: z.string().min(1),
  /** When it was captured from the live runtime (UTC ISO-8601). */
  recordedAt: z.string().min(1),
  /** How long the live `session.prompt` call took — the real cost behind PRD §5's 5-minute budget. */
  latencyMs: z.number().nonnegative(),
  /** The assistant's raw text output, exactly as the stage's parser receives it. */
  response: z.string().min(1),
});
export type StageRecording = z.infer<typeof StageRecordingSchema>;

/**
 * A stubbed/wrapped model client for one generation stage, plus what it was asked.
 *
 * All three stage clients ({@link PlanClient}, `TransformClient`, `DqClient`) are the same
 * `Pick<OpencodeClient, "session">` slice, so one value serves any of the three `ServerDeps` slots.
 */
export interface StageModel {
  /** The client to inject as `planner` / `transformer` / `dqGenerator`. */
  client: PlanClient;
  /** The model ref each prompt carried, in call order (`null` when the caller sent none). */
  prompts: (ModelRef | null)[];
}

/** Path of a stage's cassette on disk. */
function cassettePath(stage: GenerationStage): string {
  return join(CASSETTE_DIR, `${stage}.json`);
}

/**
 * Load a stage's recorded response.
 *
 * A missing cassette is a hard error, never a skip: the acceptance test must not quietly pass
 * without exercising the flow. The message says exactly how to regenerate it.
 */
export async function readRecording(stage: GenerationStage): Promise<StageRecording> {
  const path = cassettePath(stage);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new Error(
      `no recorded ${stage} response at ${path} — re-record the cassettes against the live free ` +
        `model with: ACCEPTANCE_LIVE_MODEL=1 npx vitest run tests/acceptance.test.ts`,
    );
  }
  return StageRecordingSchema.parse(JSON.parse(text));
}

/** Persist a stage's freshly-captured live response as its cassette. */
export async function writeRecording(recording: StageRecording): Promise<void> {
  await mkdir(CASSETTE_DIR, { recursive: true });
  await writeFile(
    cassettePath(recording.stage),
    `${JSON.stringify(StageRecordingSchema.parse(recording), null, 2)}\n`,
    "utf8",
  );
}

/** The shape a `session.prompt` body carries that this module cares about. */
interface PromptArgs {
  body?: { model?: ModelRef };
}

/** Build a one-text-part prompt response in the envelope the SDK returns. */
function textResponse(sessionID: string, text: string) {
  return {
    data: {
      info: {},
      parts: [{ id: "part-0", sessionID, messageID: "message-0", type: "text" as const, text }],
    },
    error: undefined,
  };
}

/**
 * A stage client that replays `recording.response` instead of calling a model.
 *
 * Only the network hop is replaced — the stage still builds its real prompt, disables its tools,
 * joins the response parts, and parses/validates the text into a schema-valid artifact, so a
 * recording that stopped being parseable would fail the test rather than be papered over.
 */
export function replayStage(recording: StageRecording): StageModel {
  const prompts: (ModelRef | null)[] = [];
  const sessionID = `replay-${recording.stage}`;
  const client = {
    session: {
      create: async () => ({ data: { id: sessionID }, error: undefined }),
      prompt: async (args: PromptArgs) => {
        prompts.push(args.body?.model ?? null);
        return textResponse(sessionID, recording.response);
      },
    },
  } as unknown as PlanClient;
  return { client, prompts };
}

/** A live stage client plus the recordings it captured. */
export interface RecordingStageModel extends StageModel {
  /** Responses captured from the live runtime, one per prompt call. */
  recordings: StageRecording[];
}

/**
 * Wrap the real OpenCode client so every prompt this stage makes is captured as a cassette.
 *
 * Used by `ACCEPTANCE_LIVE_MODEL=1`: the flow runs against the live free model and the responses
 * it returns become the recordings the default (replay) mode then executes.
 */
export function recordingStage(
  client: OpencodeClient,
  stage: GenerationStage,
  now: () => Date = () => new Date(),
): RecordingStageModel {
  const prompts: (ModelRef | null)[] = [];
  const recordings: StageRecording[] = [];
  const wrapped = {
    session: {
      create: (args: unknown) =>
        client.session.create(args as Parameters<OpencodeClient["session"]["create"]>[0]),
      prompt: async (args: PromptArgs) => {
        const model = args.body?.model ?? null;
        prompts.push(model);
        const startedAt = Date.now();
        const res = await client.session.prompt(
          args as Parameters<OpencodeClient["session"]["prompt"]>[0],
        );
        const latencyMs = Date.now() - startedAt;
        // Join contiguous text parts with no separator, exactly as the stage's own collector does —
        // a JSON payload split mid-token must reconstruct byte-for-byte to stay parseable.
        const response = (res.data?.parts ?? [])
          .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
          .map((part) => part.text)
          .join("");
        if (response.length > 0) {
          recordings.push({
            stage,
            model: model ? `${model.providerID}/${model.modelID}` : "runtime-default",
            recordedAt: now().toISOString(),
            latencyMs,
            response,
          });
        }
        return res;
      },
    },
  } as unknown as PlanClient;
  return { client: wrapped, prompts, recordings };
}
