import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { buildServer, type RunLauncher } from "../server/app.js";
import { openStore, type WarehouseStore } from "../server/store/duckdb.js";
import { createRunApprovalGate } from "../server/pipeline/run-approvals.js";
import { runPipeline } from "../server/pipeline/runner.js";
import {
  createDatastackOpencode,
  type DatastackOpencode,
} from "../server/opencode/client.js";
import { ASK_TOOLS, DEFAULT_MODEL, isAskTool } from "../server/opencode/config.js";
import { PlanSchema } from "../server/core/plan.js";
import { TransformSchema } from "../server/core/transform.js";
import { DqSpecSchema, MIN_DQ_CHECKS, type DqSpec } from "../server/core/dq.js";
import { SourceSchema } from "../server/core/sources.js";
import { ProjectSchema } from "../server/core/projects.js";
import { ReviewArtifactsResponseSchema } from "../server/core/artifacts.js";
import { SourceProfileSchema } from "../server/core/profile.js";
import { RunLineageSchema, type RunLineage } from "../server/core/lineage.js";
import { ServedDataSchema, ServedTableSchema } from "../server/core/serving.js";
import {
  RunApprovalRequestSchema,
  RunStateSchema,
  type RunEvent,
} from "../server/core/run.js";
import {
  GENERATION_STAGES,
  readRecording,
  recordingStage,
  replayStage,
  writeRecording,
  type GenerationStage,
  type ModelRef,
  type RecordingStageModel,
  type StageModel,
  type StageRecording,
} from "./helpers/model-cassette.js";

/**
 * PRD §5 acceptance test (T6.2) — the whole product flow, on the committed synthetic fixture,
 * asserting each of the six acceptance criteria the MVP is "done" by.
 *
 * This is the end-to-end proof, so it runs the **real production path**: a real Fastify app built
 * by `buildServer` with the real `runPipeline` launcher, a real DuckDB warehouse, the real tools
 * (`land_parquet` → `load_warehouse` → `run_transform` → `run_dq_check` → `publish_serving`), the
 * real approval gate, and the real serving routes — driven over a real socket with `fetch`, exactly
 * as the browser drives it: create project → upload CSV → profile → rules → plan → transform → DQ →
 * review → run (approving every gate) → read the served report back over REST and as CSV.
 *
 * **The one thing not live is the model call.** The three generation stages replay responses
 * `opencode/big-pickle` genuinely produced against this fixture (see
 * {@link file://./helpers/model-cassette.ts}) — so the SQL executed here is the free model's own
 * SQL, but `npm test` does not depend on a free model's availability or mood. Re-record and prove
 * criterion 6 by execution with:
 *
 * ```
 * ACCEPTANCE_LIVE_MODEL=1 npx vitest run tests/acceptance.test.ts
 * ```
 *
 * which runs this identical flow against a live OpenCode runtime on the free model.
 *
 * Assertions follow LOOP §5: invariants for the model-generated artifacts (a schema-valid plan;
 * SQL that parses and executes; ≥3 DQ checks), structure **and** values for the deterministic
 * output (the served report is queryable and downloadable, and both routes agree). Row order is
 * never asserted — the generated transform has no `ORDER BY` (AGENTS lesson).
 */

/** Live mode: drive the generation stages against the real runtime and re-record the cassettes. */
const LIVE = process.env.ACCEPTANCE_LIVE_MODEL === "1";

/** PRD §5: "Time from CSV upload to served output is under 5 minutes." */
const FIVE_MINUTES_MS = 5 * 60 * 1000;

/** The free model the whole flow must run on (PRD §5, FR11). */
const FREE_MODEL_REF: ModelRef = { providerID: "opencode", modelID: "big-pickle" };

/** Ceiling on the scripted run itself, so a deadlocked gate fails loudly instead of hanging. */
const RUN_DEADLINE_MS = 120_000;

const CSV_PATH = fileURLToPath(new URL("../fixtures/loans_sample.csv", import.meta.url));
const RULES_PATH = fileURLToPath(new URL("../fixtures/rules.txt", import.meta.url));

/** `GET /api/runs/:runId` — run state plus the gates still awaiting a human. */
const LiveRunStateSchema = RunStateSchema.extend({
  approvals: z.array(RunApprovalRequestSchema),
});

/** What the flow observed, asserted criterion-by-criterion below. */
interface AcceptanceFlow {
  /** Wall-clock from the CSV upload to the served CSV download landing. */
  elapsedMs: number;
  /** Model latency to add back when replaying, so criterion 1 stays an honest measurement. */
  replayedModelLatencyMs: number;
  runId: string;
  /** The `model` column persisted on the run row. */
  runModel: string | null;
  steps: z.infer<typeof RunStateSchema>["steps"];
  runStatus: string;
  lineage: RunLineage;
  /** Progress events the runner emitted (FR9) — the stream the SSE bridge fans to the UI. */
  events: RunEvent[];
  dqSpec: DqSpec;
  /**
   * One probe per gate: the tools already executed at the moment the human answered it. This is
   * the race-free evidence for "no write/execute ran unapproved" — it is read *before* the
   * approval is posted, so a tool appearing here would mean it ran without consent.
   */
  probes: { tool: string; toolsRunBeforeApproval: string[] }[];
  servedName: string;
  servedData: z.infer<typeof ServedDataSchema>;
  csv: { status: number; contentType: string; disposition: string; body: string };
  /** The model ref each generation stage was prompted with. */
  prompts: Record<GenerationStage, (ModelRef | null)[]>;
  /** The recording behind each generation stage — replayed, or captured live this run. */
  recordings: Record<GenerationStage, StageRecording>;
}

describe(`PRD §5 acceptance — ${LIVE ? "live free model" : "replayed free-model responses"}`, () => {
  let app: FastifyInstance;
  let store: WarehouseStore;
  let runtime: DatastackOpencode | undefined;
  const tmpDirs: string[] = [];
  let flow: AcceptanceFlow;

  afterAll(async () => {
    await app?.close();
    await store?.close();
    runtime?.close();
    await Promise.all(tmpDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  beforeAll(async () => {
    const root = await mkdtemp(join(tmpdir(), "datastack-acceptance-"));
    tmpDirs.push(root);
    store = await openStore(":memory:");

    // Wire the three generation stages: live (recording as it goes) or replaying the cassettes.
    const stages = {} as Record<GenerationStage, StageModel>;
    const recordings = {} as Record<GenerationStage, StageRecording>;
    let liveStages: Record<GenerationStage, RecordingStageModel> | undefined;
    if (LIVE) {
      runtime = await createDatastackOpencode({ hostname: "127.0.0.1" });
      const client = runtime.client;
      liveStages = {
        plan: recordingStage(client, "plan"),
        transform: recordingStage(client, "transform"),
        dq: recordingStage(client, "dq"),
      };
      for (const stage of GENERATION_STAGES) stages[stage] = liveStages[stage];
    } else {
      for (const stage of GENERATION_STAGES) {
        recordings[stage] = await readRecording(stage);
        stages[stage] = replayStage(recordings[stage]);
      }
    }

    // The production wiring from index.ts: the runner's gates park on the run approval gate the
    // approvals route answers, and its progress events go to the sink the SSE bridge feeds.
    const events: RunEvent[] = [];
    const runApprovals = createRunApprovalGate();
    const launchRun: RunLauncher = ({ run, steps, source, transform, dqSpec }) => {
      void runPipeline({
        store,
        runId: run.id,
        steps,
        source,
        transform,
        dqSpec,
        landingDir: join(root, "landing"),
        servingDir: join(root, "serving"),
        approve: (request) => runApprovals.request(request),
        emit: (event) => events.push(event),
      }).catch((error) => console.error("acceptance pipeline failed:", error));
    };

    app = buildServer({
      store,
      planner: stages.plan.client,
      transformer: stages.transform.client,
      dqGenerator: stages.dq.client,
      runApprovals,
      launchRun,
      uploadsDir: join(root, "uploads"),
      artifactsDir: join(root, "artifacts"),
    });
    const base = await app.listen({ port: 0, host: "127.0.0.1" });

    /** GET `path` and validate the payload against its real wire contract. */
    async function getJson<T>(path: string, schema: z.ZodType<T>): Promise<T> {
      const res = await fetch(`${base}${path}`);
      expect(`GET ${path} → ${res.status}`).toBe(`GET ${path} → 200`);
      return schema.parse(await res.json());
    }

    /** POST JSON to `path`, expect `status`, and validate the payload. */
    async function postJson<T>(
      path: string,
      body: unknown,
      status: number,
      schema: z.ZodType<T>,
    ): Promise<T> {
      const res = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await res.json();
      expect(`POST ${path} → ${res.status} ${JSON.stringify(payload)}`.slice(0, 300)).toBe(
        `POST ${path} → ${status} ${JSON.stringify(payload)}`.slice(0, 300),
      );
      return schema.parse(payload);
    }

    // ── FR1: create the project ────────────────────────────────────────────────────────────
    const project = await postJson(
      "/api/projects",
      { name: "Lending acceptance", domain: "lending", expectedVolume: "small" },
      201,
      ProjectSchema,
    );

    // ── FR2: upload the synthetic fixture CSV. The acceptance clock starts here: PRD §5 measures
    // "time from CSV upload to served output". ───────────────────────────────────────────────
    const startedAt = Date.now();
    const form = new FormData();
    form.append(
      "file",
      new Blob([await readFile(CSV_PATH)], { type: "text/csv" }),
      "loans_sample.csv",
    );
    const uploadRes = await fetch(`${base}/api/projects/${project.id}/source`, {
      method: "POST",
      body: form,
    });
    expect(uploadRes.status).toBe(201);
    const source = SourceSchema.parse(await uploadRes.json());

    // ── FR2: profile it ────────────────────────────────────────────────────────────────────
    await postJson(
      `/api/projects/${project.id}/profile`,
      { sourceId: source.id },
      200,
      z.object({ source: SourceSchema, profile: SourceProfileSchema }),
    );

    // ── FR6: the plain-English rules doc the transform is generated from ───────────────────
    await postJson(
      `/api/projects/${project.id}/rules`,
      { rules: await readFile(RULES_PATH, "utf8") },
      201,
      z.object({ id: z.string() }).loose(),
    );

    // ── FR3/FR6/FR7: the three generation stages, each pinned to the free model ────────────
    const planBody = { sourceId: source.id, model: DEFAULT_MODEL };
    const { plan } = await postJson(
      `/api/projects/${project.id}/plan`,
      planBody,
      200,
      z.object({ plan: PlanSchema }).loose(),
    );
    const { transform } = await postJson(
      `/api/projects/${project.id}/transform`,
      planBody,
      200,
      z.object({ transform: TransformSchema }).loose(),
    );
    const { dq } = await postJson(
      `/api/projects/${project.id}/dq`,
      planBody,
      200,
      z.object({ dq: DqSpecSchema }).loose(),
    );

    // Persist what the live model just produced BEFORE the run executes it: a transform that
    // fails downstream is exactly the outcome worth having on disk to inspect.
    if (liveStages) {
      for (const stage of GENERATION_STAGES) {
        const captured = liveStages[stage].recordings[0];
        if (!captured) throw new Error(`the live ${stage} stage captured no model response`);
        recordings[stage] = captured;
        await writeRecording(captured);
      }
    }

    // ── T3.5: the human reviews the generated artifacts before anything executes ───────────
    const review = await getJson(
      `/api/projects/${project.id}/artifacts`,
      ReviewArtifactsResponseSchema,
    );
    expect(review.plan?.kind).toBe("plan");
    expect(review.transform?.kind).toBe("transform_sql");
    expect(review.dq?.kind).toBe("dq_spec");

    // ── FR9: start the run ─────────────────────────────────────────────────────────────────
    const started = await postJson(
      `/api/projects/${project.id}/run`,
      { sourceId: source.id, model: DEFAULT_MODEL },
      202,
      RunStateSchema,
    );
    const runId = started.run.id;

    // ── FR8: answer every gate. Before each approval, read the lineage: the tool about to be
    // approved must not have executed yet. Reading it *before* posting the decision is what makes
    // this evidence rather than a timestamp comparison that could race. ──────────────────────
    const probes: AcceptanceFlow["probes"] = [];
    const deadline = Date.now() + RUN_DEADLINE_MS;
    let state = await getJson(`/api/runs/${runId}`, LiveRunStateSchema);
    while (state.run.status === "pending" || state.run.status === "running") {
      for (const request of state.approvals) {
        const before = await getJson(`/api/runs/${runId}/lineage`, RunLineageSchema);
        probes.push({
          tool: request.tool,
          toolsRunBeforeApproval: before.toolCalls.map((call) => call.tool),
        });
        await postJson(
          `/api/runs/${runId}/approvals/${request.requestID}`,
          { action: "approve" },
          200,
          z.object({ status: z.literal("approved") }).loose(),
        );
      }
      if (Date.now() > deadline) {
        throw new Error(`run ${runId} did not finish within ${RUN_DEADLINE_MS}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
      state = await getJson(`/api/runs/${runId}`, LiveRunStateSchema);
    }
    if (state.run.status !== "success") {
      const detail = state.steps
        .map((step) => `${step.name}=${step.status}${step.detail ? ` (${step.detail})` : ""}`)
        .join(" · ");
      throw new Error(`run ended "${state.run.status}": ${detail}`);
    }

    // ── FR10: read the report back through its own generated endpoints ─────────────────────
    const { served } = await getJson(
      `/api/projects/${project.id}/served`,
      z.object({ served: z.array(ServedTableSchema) }),
    );
    const table = served[0];
    if (!table) throw new Error("the run succeeded but registered no served table");

    const servedData = await getJson(table.endpoint, ServedDataSchema);
    const csvRes = await fetch(`${base}${table.csvEndpoint}`);
    const csv = {
      status: csvRes.status,
      contentType: csvRes.headers.get("content-type") ?? "",
      disposition: csvRes.headers.get("content-disposition") ?? "",
      body: await csvRes.text(),
    };
    const elapsedMs = Date.now() - startedAt;

    const lineage = await getJson(`/api/runs/${runId}/lineage`, RunLineageSchema);

    flow = {
      elapsedMs,
      // Replay skips the model round-trips, so add their recorded cost back: criterion 1 is only
      // an honest claim about the real flow if the model's real latency is in the number.
      replayedModelLatencyMs: LIVE
        ? 0
        : GENERATION_STAGES.reduce((sum, stage) => sum + recordings[stage].latencyMs, 0),
      runId,
      runModel: state.run.model,
      steps: state.steps,
      runStatus: state.run.status,
      lineage,
      events,
      dqSpec: dq,
      probes,
      servedName: table.name,
      servedData,
      csv,
      prompts: {
        plan: stages.plan.prompts,
        transform: stages.transform.prompts,
        dq: stages.dq.prompts,
      },
      recordings,
    };

    // The plan is model output, so assert its contract rather than its prose (LOOP §5).
    expect(plan.steps.length).toBeGreaterThan(0);
    expect(transform.sql.length).toBeGreaterThan(0);
  }, LIVE ? 600_000 : 120_000);

  describe("acceptance criteria", () => {
    it("serves the output under 5 minutes after the CSV upload", () => {
      const totalMs = flow.elapsedMs + flow.replayedModelLatencyMs;

      expect(totalMs).toBeLessThan(FIVE_MINUTES_MS);
      // The measurement must cover the real flow, not an empty one: the run really executed.
      expect(flow.runStatus).toBe("success");
      expect(flow.lineage.toolCalls.length).toBeGreaterThanOrEqual(5);
    });

    it("required a human approval before 100% of write/execute tool calls", () => {
      const gatedCalls = flow.lineage.toolCalls.filter((call) => isAskTool(call.tool));

      // Every write/execute tool the pipeline has, ran — and every one of them ran gated.
      expect([...gatedCalls.map((call) => call.tool)].sort()).toEqual([...ASK_TOOLS].sort());
      expect(gatedCalls.every((call) => call.status === "success")).toBe(true);

      // Exactly one approve decision per gated call, and no decision was anything else.
      expect(flow.lineage.approvals.every((record) => record.action === "approve")).toBe(true);
      expect([...flow.lineage.approvals.map((record) => record.tool)].sort()).toEqual(
        [...gatedCalls.map((call) => call.tool)].sort(),
      );

      // The race-free part: at the instant each gate was answered, its tool had not yet run.
      expect(flow.probes.map((probe) => probe.tool)).toEqual(gatedCalls.map((call) => call.tool));
      for (const probe of flow.probes) {
        expect(`${probe.tool} ran before approval: ${probe.toolsRunBeforeApproval.join()}`).toBe(
          `${probe.tool} ran before approval: ${probe.toolsRunBeforeApproval
            .filter((tool) => tool !== probe.tool)
            .join()}`,
        );
      }

      // Nothing executed outside that set except the read-only DQ checks (permission `allow`).
      const ungated = flow.lineage.toolCalls
        .filter((call) => !isAskTool(call.tool))
        .map((call) => call.tool);
      expect([...new Set(ungated)]).toEqual(["run_dq_check"]);
    });

    it("shows at least 5 visible pipeline tasks, all of which succeeded", () => {
      expect(flow.steps.length).toBeGreaterThanOrEqual(5);
      expect(flow.steps.map((step) => `${step.name}=${step.status}`)).toEqual(
        flow.steps.map((step) => `${step.name}=success`),
      );

      // "Shows" is the progress stream the UI renders: every task reported its status (FR9).
      const streamed = new Set(
        flow.events.filter((event) => event.kind === "step.status").map((event) => event.name),
      );
      expect(streamed.size).toBeGreaterThanOrEqual(5);
      expect([...streamed].sort()).toEqual(flow.steps.map((step) => step.name).sort());
    });

    it("generated and automatically executed at least 3 data-quality checks", () => {
      expect(flow.dqSpec.checks.length).toBeGreaterThanOrEqual(MIN_DQ_CHECKS);
      expect(flow.lineage.dqResults.length).toBeGreaterThanOrEqual(MIN_DQ_CHECKS);

      // Every generated check has a recorded outcome, and each passed — so publish was not blocked.
      expect(new Set(flow.lineage.dqResults.map((result) => result.checkName))).toEqual(
        new Set(flow.dqSpec.checks.map((check) => check.name)),
      );
      expect(flow.lineage.dqResults.every((result) => result.passed)).toBe(true);

      // "Automatically": the DQ stage is read-only and ran without asking a human.
      expect(flow.lineage.approvals.map((record) => record.tool)).not.toContain("run_dq_check");
    });

    it("serves the final output over REST and as a CSV download", () => {
      // Queryable (REST).
      expect(flow.servedData.rowCount).toBeGreaterThan(0);
      expect(flow.servedData.rows.length).toBe(flow.servedData.rowCount);
      expect(flow.servedData.columns.length).toBeGreaterThan(0);
      expect(flow.servedData.schema).toBe("marts");

      // Downloadable (CSV) — as an attachment the browser saves, not an inline body.
      expect(flow.csv.status).toBe(200);
      expect(flow.csv.contentType).toContain("text/csv");
      expect(flow.csv.disposition).toBe(
        `attachment; filename="${flow.servedName}.csv"`,
      );

      // Both endpoints answer with the same report. Row *order* is not a contract (the generated
      // transform has no ORDER BY), so compare the header and the row count, not row identity.
      const lines = flow.csv.body.trim().split("\n");
      const header = lines[0];
      expect(header?.split(",")).toEqual(flow.servedData.columns.map((column) => column.name));
      expect(lines.length - 1).toBe(flow.servedData.rowCount);
    });

    it("ran the flow on the free opencode/big-pickle model", () => {
      // Every generation stage was routed to the free model...
      for (const stage of GENERATION_STAGES) {
        expect(`${stage}: ${JSON.stringify(flow.prompts[stage])}`).toBe(
          `${stage}: ${JSON.stringify([FREE_MODEL_REF])}`,
        );
        // ...and the response it worked from was produced by that model, live.
        expect(flow.recordings[stage].model).toBe(DEFAULT_MODEL);
        expect(flow.recordings[stage].stage).toBe(stage);
      }
      // ...and the run itself is stamped with it.
      expect(flow.runModel).toBe(DEFAULT_MODEL);
      expect(DEFAULT_MODEL).toBe(`${FREE_MODEL_REF.providerID}/${FREE_MODEL_REF.modelID}`);
    });
  });
});
