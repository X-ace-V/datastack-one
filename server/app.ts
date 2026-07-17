import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { HealthStatusSchema, type HealthStatus } from "./core/types.js";
import { ApprovalDecisionSchema } from "./core/approvals.js";
import { CreateProjectRequestSchema } from "./core/projects.js";
import { ProfileRequestSchema } from "./core/profile.js";
import { RulesInputSchema } from "./core/artifacts.js";
import { PlanRequestSchema, PlanParseError } from "./core/plan.js";
import { TransformRequestSchema, TransformParseError } from "./core/transform.js";
import { DqRequestSchema, DqParseError, DqSpecSchema, type DqSpec } from "./core/dq.js";
import { isCsvFilename, type Source } from "./core/sources.js";
import { TransformSchema, type Transform } from "./core/transform.js";
import {
  PIPELINE_STAGES,
  RunStartRequestSchema,
  type Run,
  type RunStep,
} from "./core/run.js";
import { listModels, type ModelsClient } from "./opencode/models.js";
import { runPlanStage, PlanRuntimeError, type PlanClient } from "./pipeline/plan.js";
import {
  runTransformStage,
  TransformRuntimeError,
  type TransformClient,
} from "./pipeline/transform.js";
import { runDqStage, DqRuntimeError, type DqClient } from "./pipeline/dq.js";
import type { RunBridge } from "./opencode/bridge.js";
import type { WarehouseStore } from "./store/duckdb.js";
import { getProject, insertProject, listProjects } from "./store/projects.js";
import {
  getSource,
  insertSource,
  listSources,
  updateSourceRowCount,
} from "./store/sources.js";
import { profileSource } from "./tools/profile.js";
import { DEFAULT_ARTIFACTS_DIR, writeArtifact } from "./tools/rules.js";
import { getLatestArtifactByKind } from "./store/artifacts.js";
import { DEFAULT_UPLOADS_DIR, saveUpload } from "./store/uploads.js";
import {
  createRun,
  getRunState,
  insertRunStep,
  recordApproval,
} from "./store/runs.js";
import {
  UnknownRunApprovalError,
  type RunApprovalGate,
} from "./pipeline/run-approvals.js";
import {
  ApprovalReplyError,
  UnknownApprovalError,
  type ApprovalGate,
} from "./opencode/approvals.js";

/**
 * Fire-and-forget launcher for a run's scripted pipeline (T4.4). The route creates the run + its
 * steps, then hands them here; the launcher owns the per-run wiring of the approval gate and the
 * SSE emit so the route stays transport-agnostic and its tests can inject a spy. Never awaited —
 * a run pauses for human approval, so it outlives the HTTP request that started it.
 */
export type RunLauncher = (input: {
  run: Run;
  steps: RunStep[];
  source: Source;
  transform: Transform;
  dqSpec: DqSpec;
}) => void;

/** Backend identity, surfaced by `/api/health` so a client can confirm the target. */
export const SERVICE_NAME = "datastack-one";
export const SERVICE_VERSION = "0.0.0";

/**
 * Runtime dependencies the server routes need. Injected so tests can drive the app
 * with a mocked OpenCode client (no `opencode` subprocess) and so {@link file://./index.ts}
 * can wire the real runtime at boot.
 */
export interface ServerDeps {
  /** OpenCode client slice used by `GET /api/models`. Absent → the route reports 503. */
  opencode?: ModelsClient;
  /**
   * OpenCode client slice used by the plan stage (`POST /api/projects/:id/plan`, FR3) — it
   * needs `session.create`/`session.prompt`, a wider surface than {@link ModelsClient}.
   * Injected separately so the plan route's tests can mock just the session, and so a
   * health-only boot (no runtime) reports 503 rather than pretending to plan.
   */
  planner?: PlanClient;
  /**
   * OpenCode client slice used by the transform stage (`POST /api/projects/:id/transform`,
   * FR6) — the same `session` surface as {@link planner}, injected separately so its route's
   * tests can mock just the session and a health-only boot (no runtime) reports 503.
   */
  transformer?: TransformClient;
  /**
   * OpenCode client slice used by the DQ stage (`POST /api/projects/:id/dq`, FR7) — the same
   * `session` surface as {@link transformer}, injected separately so its route's tests can mock
   * just the session and a health-only boot (no runtime) reports 503.
   */
  dqGenerator?: DqClient;
  /**
   * Bridge relaying OpenCode progress events to SSE (FR9). Absent → the run-events route
   * reports 503, since a health-only boot has no runtime to stream from.
   */
  bridge?: RunBridge;
  /**
   * Approval gate holding pending permission requests (FR8). Absent → the approvals route
   * reports 503, since a health-only boot has no runtime to approve against.
   */
  approvals?: ApprovalGate;
  /**
   * Launcher that executes a run's scripted pipeline in the background (FR9, T4.4). Absent →
   * `POST /api/projects/:id/run` reports 503, since a health-only boot cannot run a pipeline.
   */
  launchRun?: RunLauncher;
  /**
   * Approval gate the scripted runner parks gated stages on (FR8, T4.4). Answered by
   * `POST /api/runs/:runId/approvals/:requestID`. Absent → that route reports 503. Distinct
   * from {@link ServerDeps.approvals} (the OpenCode permission gate).
   */
  runApprovals?: RunApprovalGate;
  /**
   * Metadata store backing the project routes (FR1). Absent → the project routes report
   * 503, since a health-only boot has no warehouse to persist to.
   */
  store?: WarehouseStore;
  /**
   * Directory uploaded CSVs are written to (FR2). Defaults to {@link DEFAULT_UPLOADS_DIR};
   * tests override it with a tmp dir so they never touch the repo's `data/`.
   */
  uploadsDir?: string;
  /**
   * Directory generated artifacts (rules docs, plan, SQL, DDL, DQ spec) are written to
   * (FR6). Defaults to {@link DEFAULT_ARTIFACTS_DIR}; tests override it with a tmp dir so
   * they never touch the repo's `data/`.
   */
  artifactsDir?: string;
}

/** Hard cap on an uploaded CSV, keeping a stray huge file from filling the disk. */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/**
 * Build the Fastify instance with all routes registered but not yet listening.
 * Kept separate from {@link file://./index.ts} boot so tests can drive it via
 * `app.inject(...)` without binding a port.
 */
export function buildServer(deps: ServerDeps = {}): FastifyInstance {
  const app = Fastify({ logger: false });
  const uploadsDir = deps.uploadsDir ?? DEFAULT_UPLOADS_DIR;
  const artifactsDir = deps.artifactsDir ?? DEFAULT_ARTIFACTS_DIR;

  // FR2: accept CSV uploads as multipart/form-data. Registered for the whole app; only the
  // source-upload route reads a file, and the size cap guards the disk.
  app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });

  app.get("/api/health", async (): Promise<HealthStatus> => {
    // Build then validate against the shared contract so the route can never
    // drift from what clients are told to expect.
    return HealthStatusSchema.parse({
      status: "ok",
      service: SERVICE_NAME,
      version: SERVICE_VERSION,
      uptime: process.uptime(),
    });
  });

  // FR11: list live providers/models from the OpenCode runtime. When the runtime is
  // not wired (e.g. a health-only boot), report unavailable honestly rather than
  // pretending an empty catalog is the truth.
  app.get("/api/models", async (_req, reply) => {
    if (!deps.opencode) {
      return reply.code(503).send({ error: "model runtime unavailable" });
    }
    return await listModels(deps.opencode);
  });

  // FR1: create a project. The body is validated against the shared contract (400 on a bad
  // request); on success the persisted row — with its server-generated id, applied warehouse
  // default, and created_at timestamp — is returned with 201. All user fields are bound as
  // parameters by the store, so nothing here concatenates input into SQL.
  app.post("/api/projects", async (req, reply) => {
    if (!deps.store) {
      return reply.code(503).send({ error: "project store unavailable" });
    }

    const parsed = CreateProjectRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid project", details: parsed.error.issues });
    }

    const project = await insertProject(deps.store, parsed.data);
    return reply.code(201).send(project);
  });

  // FR1: list projects, newest first, for the create page and later wizard steps.
  app.get("/api/projects", async (_req, reply) => {
    if (!deps.store) {
      return reply.code(503).send({ error: "project store unavailable" });
    }
    const projects = await listProjects(deps.store);
    return reply.code(200).send({ projects });
  });

  // FR2: upload a CSV source for a project. The raw file lands under `data/uploads/` and a
  // row is recorded in `platform.sources`; profiling (schema, row count) is a later step, so
  // the stored row leaves those unset for now. 404 if the project is unknown, 400 for a
  // missing/non-CSV/empty/oversized file.
  app.post<{ Params: { id: string } }>(
    "/api/projects/:id/source",
    async (req, reply) => {
      if (!deps.store) {
        return reply.code(503).send({ error: "project store unavailable" });
      }
      if (!req.isMultipart()) {
        return reply.code(400).send({ error: "expected a multipart/form-data upload" });
      }

      const project = await getProject(deps.store, req.params.id);
      if (!project) {
        return reply.code(404).send({ error: "project not found" });
      }

      const data = await req.file();
      if (!data) {
        return reply.code(400).send({ error: "a CSV file is required" });
      }
      if (!isCsvFilename(data.filename)) {
        return reply.code(400).send({ error: "only .csv files are supported" });
      }

      let content: Buffer;
      try {
        content = await data.toBuffer();
      } catch {
        // @fastify/multipart throws once the byte stream exceeds the configured limit.
        return reply
          .code(400)
          .send({ error: "the uploaded file exceeds the size limit" });
      }
      if (content.length === 0) {
        return reply.code(400).send({ error: "the uploaded file is empty" });
      }

      const sourceId = randomUUID();
      const path = await saveUpload({
        dir: uploadsDir,
        projectId: project.id,
        sourceId,
        originalFilename: data.filename,
        content,
      });
      const source = await insertSource(deps.store, {
        id: sourceId,
        projectId: project.id,
        path,
        originalFilename: data.filename,
      });
      return reply.code(201).send(source);
    },
  );

  // FR2: list a project's uploaded sources so the Connect page can show what has landed.
  app.get<{ Params: { id: string } }>(
    "/api/projects/:id/sources",
    async (req, reply) => {
      if (!deps.store) {
        return reply.code(503).send({ error: "project store unavailable" });
      }
      const project = await getProject(deps.store, req.params.id);
      if (!project) {
        return reply.code(404).send({ error: "project not found" });
      }
      const sources = await listSources(deps.store, project.id);
      return reply.code(200).send({ sources });
    },
  );

  // FR2: profile a project's uploaded CSV source. Runs the read-only `profile_source` tool
  // against the source on disk (schema, types, row count, null %, candidate keys, date cols)
  // and records the discovered row count on the source. The body may name a `sourceId`; when
  // omitted, the project's most recent source is profiled. 404 if the project or source is
  // unknown, 400 if there is nothing to profile or the source belongs to another project.
  app.post<{ Params: { id: string } }>(
    "/api/projects/:id/profile",
    async (req, reply) => {
      if (!deps.store) {
        return reply.code(503).send({ error: "project store unavailable" });
      }

      const parsed = ProfileRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "invalid profile request", details: parsed.error.issues });
      }

      const project = await getProject(deps.store, req.params.id);
      if (!project) {
        return reply.code(404).send({ error: "project not found" });
      }

      // Resolve the source to profile: the named one, or the newest upload for the project.
      let source;
      if (parsed.data.sourceId) {
        source = await getSource(deps.store, parsed.data.sourceId);
        if (!source || source.projectId !== project.id) {
          return reply.code(404).send({ error: "source not found" });
        }
      } else {
        const sources = await listSources(deps.store, project.id);
        source = sources[0];
        if (!source) {
          return reply.code(400).send({ error: "no source to profile" });
        }
      }

      let profile;
      try {
        profile = await profileSource(deps.store, source.path);
      } catch (err) {
        // read_csv_auto failed (missing file, unreadable CSV) — report it rather than 500.
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(422).send({ error: `could not profile source: ${message}` });
      }

      // Persist the discovered row count so the source row reflects the profile.
      const updated =
        (await updateSourceRowCount(deps.store, source.id, profile.rowCount)) ?? source;
      return reply.code(200).send({ source: updated, profile });
    },
  );

  // FR3: generate an architecture plan for a project. Profiles the source for context (the
  // named `sourceId`, else the project's newest upload), reads the current rules doc if any,
  // then drives one constrained, tool-free `session.prompt` that returns a structured plan
  // (execution pattern, warehouse, partitioning, ordered steps). The validated plan is
  // persisted as a `plan` artifact via `write_artifact` so the Review step can render it.
  // Status map: 503 unwired store/planner, 400 bad body / no source, 404 unknown project or
  // cross-project source, 422 unreadable CSV or a model output that is not a valid plan, 502
  // the agent runtime failed, 200 success.
  app.post<{ Params: { id: string } }>(
    "/api/projects/:id/plan",
    async (req, reply) => {
      if (!deps.store) {
        return reply.code(503).send({ error: "project store unavailable" });
      }
      if (!deps.planner) {
        return reply.code(503).send({ error: "planning runtime unavailable" });
      }

      const parsed = PlanRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "invalid plan request", details: parsed.error.issues });
      }

      const project = await getProject(deps.store, req.params.id);
      if (!project) {
        return reply.code(404).send({ error: "project not found" });
      }

      // Resolve the source to profile: the named one, or the newest upload for the project.
      let source;
      if (parsed.data.sourceId) {
        source = await getSource(deps.store, parsed.data.sourceId);
        if (!source || source.projectId !== project.id) {
          return reply.code(404).send({ error: "source not found" });
        }
      } else {
        const sources = await listSources(deps.store, project.id);
        source = sources[0];
        if (!source) {
          return reply.code(400).send({ error: "no source to plan from" });
        }
      }

      let profile;
      try {
        profile = await profileSource(deps.store, source.path);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(422).send({ error: `could not profile source: ${message}` });
      }

      const rulesArtifact = await getLatestArtifactByKind(
        deps.store,
        project.id,
        "rules",
      );

      let plan;
      try {
        plan = await runPlanStage(deps.planner, {
          profile,
          rules: rulesArtifact?.content ?? null,
          model: parsed.data.model,
        });
      } catch (err) {
        if (err instanceof PlanParseError) {
          return reply.code(422).send({ error: `could not generate a plan: ${err.message}` });
        }
        if (err instanceof PlanRuntimeError) {
          return reply.code(502).send({ error: err.message });
        }
        throw err;
      }

      const artifact = await writeArtifact(deps.store, {
        dir: artifactsDir,
        projectId: project.id,
        kind: "plan",
        name: "plan.json",
        content: JSON.stringify(plan, null, 2),
      });
      return reply.code(200).send({ plan, artifact });
    },
  );

  // FR6: generate the transformation SQL for a project. Profiles the source for schema context
  // (the named `sourceId`, else the project's newest upload), reads the current rules doc, then
  // drives one constrained, tool-free `session.prompt` that returns structured SQL plus the
  // assumptions and clarifying questions the agent surfaced. The validated transform is
  // persisted as a `transform_sql` artifact via `write_artifact` so the Review step can render
  // it for human approval before it ever runs. Rules are required — SQL is generated from them,
  // so a project with none on file is a 400, not an empty generation. Status map: 503 unwired
  // store/transformer, 400 bad body / no source / no rules, 404 unknown project or cross-project
  // source, 422 unreadable CSV or a model output that is not a valid transform, 502 the agent
  // runtime failed, 200 success.
  app.post<{ Params: { id: string } }>(
    "/api/projects/:id/transform",
    async (req, reply) => {
      if (!deps.store) {
        return reply.code(503).send({ error: "project store unavailable" });
      }
      if (!deps.transformer) {
        return reply.code(503).send({ error: "transform runtime unavailable" });
      }

      const parsed = TransformRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "invalid transform request", details: parsed.error.issues });
      }

      const project = await getProject(deps.store, req.params.id);
      if (!project) {
        return reply.code(404).send({ error: "project not found" });
      }

      // Resolve the source to profile: the named one, or the newest upload for the project.
      let source;
      if (parsed.data.sourceId) {
        source = await getSource(deps.store, parsed.data.sourceId);
        if (!source || source.projectId !== project.id) {
          return reply.code(404).send({ error: "source not found" });
        }
      } else {
        const sources = await listSources(deps.store, project.id);
        source = sources[0];
        if (!source) {
          return reply.code(400).send({ error: "no source to transform" });
        }
      }

      // The transform is generated *from* the rules, so they must be on file first.
      const rulesArtifact = await getLatestArtifactByKind(deps.store, project.id, "rules");
      if (!rulesArtifact?.content) {
        return reply
          .code(400)
          .send({ error: "no transformation rules on file; submit rules first" });
      }

      let profile;
      try {
        profile = await profileSource(deps.store, source.path);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(422).send({ error: `could not profile source: ${message}` });
      }

      let transform;
      try {
        transform = await runTransformStage(deps.transformer, {
          profile,
          rules: rulesArtifact.content,
          model: parsed.data.model,
        });
      } catch (err) {
        if (err instanceof TransformParseError) {
          return reply
            .code(422)
            .send({ error: `could not generate the transform: ${err.message}` });
        }
        if (err instanceof TransformRuntimeError) {
          return reply.code(502).send({ error: err.message });
        }
        throw err;
      }

      const artifact = await writeArtifact(deps.store, {
        dir: artifactsDir,
        projectId: project.id,
        kind: "transform_sql",
        name: "transform.json",
        content: JSON.stringify(transform, null, 2),
      });
      return reply.code(200).send({ transform, artifact });
    },
  );

  // FR7: generate the data-quality checks for a project. Profiles the source for schema context
  // (the named `sourceId`, else the project's newest upload), reads the current rules doc if any,
  // then drives one constrained, tool-free `session.prompt` that returns ≥3 structured checks
  // (row count, not-null, schema, freshness) against the loaded source table. The validated spec
  // is persisted as a `dq_spec` artifact via `write_artifact` so the Review step can render it;
  // executing the checks and blocking publish on failure is the later `run_dq_check` tool (T5.1).
  // Status map: 503 unwired store/dqGenerator, 400 bad body / no source, 404 unknown project or
  // cross-project source, 422 unreadable CSV or a model output that is not a valid spec, 502 the
  // agent runtime failed, 200 success.
  app.post<{ Params: { id: string } }>(
    "/api/projects/:id/dq",
    async (req, reply) => {
      if (!deps.store) {
        return reply.code(503).send({ error: "project store unavailable" });
      }
      if (!deps.dqGenerator) {
        return reply.code(503).send({ error: "DQ runtime unavailable" });
      }

      const parsed = DqRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "invalid DQ request", details: parsed.error.issues });
      }

      const project = await getProject(deps.store, req.params.id);
      if (!project) {
        return reply.code(404).send({ error: "project not found" });
      }

      // Resolve the source to profile: the named one, or the newest upload for the project.
      let source;
      if (parsed.data.sourceId) {
        source = await getSource(deps.store, parsed.data.sourceId);
        if (!source || source.projectId !== project.id) {
          return reply.code(404).send({ error: "source not found" });
        }
      } else {
        const sources = await listSources(deps.store, project.id);
        source = sources[0];
        if (!source) {
          return reply.code(400).send({ error: "no source to generate checks from" });
        }
      }

      let profile;
      try {
        profile = await profileSource(deps.store, source.path);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(422).send({ error: `could not profile source: ${message}` });
      }

      const rulesArtifact = await getLatestArtifactByKind(deps.store, project.id, "rules");

      let dq;
      try {
        dq = await runDqStage(deps.dqGenerator, {
          profile,
          rules: rulesArtifact?.content ?? null,
          model: parsed.data.model,
        });
      } catch (err) {
        if (err instanceof DqParseError) {
          return reply
            .code(422)
            .send({ error: `could not generate DQ checks: ${err.message}` });
        }
        if (err instanceof DqRuntimeError) {
          return reply.code(502).send({ error: err.message });
        }
        throw err;
      }

      const artifact = await writeArtifact(deps.store, {
        dir: artifactsDir,
        projectId: project.id,
        kind: "dq_spec",
        name: "dq.json",
        content: JSON.stringify(dq, null, 2),
      });
      return reply.code(200).send({ dq, artifact });
    },
  );

  // FR6: submit the plain-English transformation rules document for a project. Rules may
  // arrive two ways (PRD §9.3) — a multipart file upload, or a JSON `{ rules }` body from the
  // UI textarea. Either way the text is written to `data/artifacts/` via the `write_artifact`
  // tool and recorded as a `rules` artifact, so a later plan stage can `read_rules` it. 404
  // if the project is unknown, 400 for an empty/whitespace-only submission.
  app.post<{ Params: { id: string } }>(
    "/api/projects/:id/rules",
    async (req, reply) => {
      if (!deps.store) {
        return reply.code(503).send({ error: "project store unavailable" });
      }

      const project = await getProject(deps.store, req.params.id);
      if (!project) {
        return reply.code(404).send({ error: "project not found" });
      }

      // Resolve the rules text + a filename from whichever input form was used.
      let content: string;
      let name: string;
      if (req.isMultipart()) {
        const data = await req.file();
        if (!data) {
          return reply.code(400).send({ error: "a rules file is required" });
        }
        let buffer: Buffer;
        try {
          buffer = await data.toBuffer();
        } catch {
          // @fastify/multipart throws once the byte stream exceeds the configured limit.
          return reply
            .code(400)
            .send({ error: "the uploaded file exceeds the size limit" });
        }
        content = buffer.toString("utf8");
        if (content.trim().length === 0) {
          return reply.code(400).send({ error: "the rules document is empty" });
        }
        name = data.filename || "rules.txt";
      } else {
        const parsed = RulesInputSchema.safeParse(req.body);
        if (!parsed.success) {
          return reply
            .code(400)
            .send({ error: "invalid rules", details: parsed.error.issues });
        }
        content = parsed.data.rules;
        name = "rules.txt";
      }

      const artifact = await writeArtifact(deps.store, {
        dir: artifactsDir,
        projectId: project.id,
        kind: "rules",
        name,
        content,
      });
      return reply.code(201).send(artifact);
    },
  );

  // FR6: fetch a project's current (most recent) rules document, or null when none has been
  // submitted yet, so the Plan page can show what is on file before generating a plan.
  app.get<{ Params: { id: string } }>(
    "/api/projects/:id/rules",
    async (req, reply) => {
      if (!deps.store) {
        return reply.code(503).send({ error: "project store unavailable" });
      }
      const project = await getProject(deps.store, req.params.id);
      if (!project) {
        return reply.code(404).send({ error: "project not found" });
      }
      const rules = await getLatestArtifactByKind(deps.store, project.id, "rules");
      return reply.code(200).send({ rules });
    },
  );

  // FR3/FR6/FR7: fetch the generated artifacts for the Review step (T3.5) — the newest
  // architecture plan, transform SQL, DDL, and DQ spec — so a human can inspect everything the
  // agent produced before approving any execution. Each is the latest of its kind, or null if
  // that generation stage has not run yet, so the UI can show what is still outstanding.
  // 503 unwired store, 404 unknown project, 200 with the four (possibly null) artifacts.
  app.get<{ Params: { id: string } }>(
    "/api/projects/:id/artifacts",
    async (req, reply) => {
      if (!deps.store) {
        return reply.code(503).send({ error: "project store unavailable" });
      }
      const project = await getProject(deps.store, req.params.id);
      if (!project) {
        return reply.code(404).send({ error: "project not found" });
      }
      const [plan, transform, ddl, dq] = await Promise.all([
        getLatestArtifactByKind(deps.store, project.id, "plan"),
        getLatestArtifactByKind(deps.store, project.id, "transform_sql"),
        getLatestArtifactByKind(deps.store, project.id, "ddl"),
        getLatestArtifactByKind(deps.store, project.id, "dq_spec"),
      ]);
      return reply.code(200).send({ plan, transform, ddl, dq });
    },
  );

  // FR7/FR8/FR9 (T4.4/T5.1): start a pipeline run for a project. Resolves the source (named or
  // newest), the reviewed transform artifact and the reviewed DQ spec (both required — the run
  // executes them), creates the run and one pending step per pipeline stage, then launches the
  // scripted runner in the background and returns 202 immediately: a run pauses for human approval,
  // so it outlives this request. The client watches progress on `GET /api/runs/:runId/events` and
  // answers gated stages via `POST /api/runs/:runId/approvals/:requestID`. Status map: 503 unwired
  // store/runner, 400 bad body / no source / no reviewed transform / no reviewed DQ spec, 404
  // unknown project or cross-project source, 422 a stored transform or DQ artifact is not valid,
  // 202 the run started.
  app.post<{ Params: { id: string } }>(
    "/api/projects/:id/run",
    async (req, reply) => {
      if (!deps.store) {
        return reply.code(503).send({ error: "project store unavailable" });
      }
      if (!deps.launchRun) {
        return reply.code(503).send({ error: "run runtime unavailable" });
      }

      const parsed = RunStartRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "invalid run request", details: parsed.error.issues });
      }

      const project = await getProject(deps.store, req.params.id);
      if (!project) {
        return reply.code(404).send({ error: "project not found" });
      }

      // Resolve the source to run: the named one, or the newest upload for the project.
      let source;
      if (parsed.data.sourceId) {
        source = await getSource(deps.store, parsed.data.sourceId);
        if (!source || source.projectId !== project.id) {
          return reply.code(404).send({ error: "source not found" });
        }
      } else {
        const sources = await listSources(deps.store, project.id);
        source = sources[0];
        if (!source) {
          return reply.code(400).send({ error: "no source to run" });
        }
      }

      // The run executes the reviewed transform, so one must have been generated + approved first.
      const transformArtifact = await getLatestArtifactByKind(
        deps.store,
        project.id,
        "transform_sql",
      );
      if (!transformArtifact?.content) {
        return reply
          .code(400)
          .send({ error: "no reviewed transform to run; generate and review one first" });
      }
      let transform;
      try {
        transform = TransformSchema.parse(JSON.parse(transformArtifact.content));
      } catch {
        return reply
          .code(422)
          .send({ error: "the stored transform artifact is not a valid transform" });
      }

      // The DQ stage runs the reviewed checks and blocks publish on failure (FR7), so a reviewed
      // DQ spec must be on file before a run can start — just like the transform above.
      const dqArtifact = await getLatestArtifactByKind(deps.store, project.id, "dq_spec");
      if (!dqArtifact?.content) {
        return reply
          .code(400)
          .send({ error: "no reviewed DQ checks to run; generate and review them first" });
      }
      let dqSpec;
      try {
        dqSpec = DqSpecSchema.parse(JSON.parse(dqArtifact.content));
      } catch {
        return reply
          .code(422)
          .send({ error: "the stored DQ artifact is not a valid DQ spec" });
      }

      // Create the run + one pending step per pipeline stage before launching, so the run is
      // fully persisted and queryable the moment the client subscribes to its progress.
      const run = await createRun(deps.store, {
        id: randomUUID(),
        projectId: project.id,
        model: parsed.data.model ?? null,
      });
      const steps: RunStep[] = [];
      for (const [ordinal, stageDef] of PIPELINE_STAGES.entries()) {
        steps.push(
          await insertRunStep(deps.store, {
            id: randomUUID(),
            runId: run.id,
            name: stageDef.name,
            ordinal,
          }),
        );
      }

      deps.launchRun({ run, steps, source, transform, dqSpec });
      return reply.code(202).send({ run, steps });
    },
  );

  // FR9/FR12 (T4.4): fetch a run's current state — the run row, its ordered steps, and any
  // approvals currently awaiting a human. Lets a client that connects mid-run (after an approval
  // was already requested over SSE) recover the pending gate rather than deadlock. 503 unwired
  // store, 404 unknown run, 200 with the state.
  app.get<{ Params: { runId: string } }>("/api/runs/:runId", async (req, reply) => {
    if (!deps.store) {
      return reply.code(503).send({ error: "project store unavailable" });
    }
    const state = await getRunState(deps.store, req.params.runId);
    if (!state) {
      return reply.code(404).send({ error: "run not found" });
    }
    const approvals = deps.runApprovals?.pending(req.params.runId) ?? [];
    return reply.code(200).send({ ...state, approvals });
  });

  // FR8 (T4.4): answer a pipeline run's gated stage. The runner parked the stage on the run
  // approval gate; a human's approve/reject here unblocks it — approve lets the tool run once,
  // reject aborts the run. The decision is recorded to `platform.approvals` for the run's lineage
  // (FR12). Status map: 503 unwired gate, 400 bad body, 404 no such pending request for this run,
  // 200 the decision was applied.
  app.post<{ Params: { runId: string; requestID: string } }>(
    "/api/runs/:runId/approvals/:requestID",
    async (req, reply) => {
      if (!deps.runApprovals) {
        return reply.code(503).send({ error: "run approval gate unavailable" });
      }

      const parsed = ApprovalDecisionSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "invalid approval decision", details: parsed.error.issues });
      }

      // The request must be pending *and* belong to this run, so a requestID cannot be answered
      // against the wrong run's URL.
      const existing = deps.runApprovals.get(req.params.requestID);
      if (!existing || existing.runId !== req.params.runId) {
        return reply
          .code(404)
          .send({ error: `no pending run approval for request "${req.params.requestID}"` });
      }

      let request;
      try {
        request = deps.runApprovals.resolve(req.params.requestID, parsed.data.action);
      } catch (err) {
        if (err instanceof UnknownRunApprovalError) {
          return reply.code(404).send({ error: err.message });
        }
        throw err;
      }

      // Audit the decision for the run's lineage (best-effort — a failed audit must not undo the
      // human's answer, which the runner has already acted on).
      if (deps.store) {
        await recordApproval(deps.store, {
          id: randomUUID(),
          runId: request.runId,
          requestId: request.requestID,
          tool: request.tool,
          args: JSON.stringify(request.args),
          action: parsed.data.action,
        });
      }

      return reply.code(200).send({
        requestID: request.requestID,
        action: parsed.data.action,
        status: parsed.data.action === "approve" ? "approved" : "rejected",
      });
    },
  );

  // FR9: stream a run's progress (agent reasoning, tool calls, per-stage status) to the UI
  // as Server-Sent Events. The bridge fans the OpenCode event stream out per run; here we
  // just open a long-lived SSE response and forward each frame the bridge hands us until
  // the client disconnects. Fastify's reply is hijacked so it does not also try to send.
  app.get<{ Params: { runId: string } }>("/api/runs/:runId/events", (req, reply) => {
    if (!deps.bridge) {
      return reply.code(503).send({ error: "run event stream unavailable" });
    }

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Defeat proxy buffering so frames arrive as they are produced.
      "x-accel-buffering": "no",
    });
    // An initial comment flushes headers immediately and primes the connection.
    res.write(": connected\n\n");

    const unsubscribe = deps.bridge.subscribe(req.params.runId, (frame) => {
      res.write(frame);
    });

    req.raw.on("close", () => {
      unsubscribe();
      res.end();
    });

    return reply;
  });

  // FR8: resolve a pending permission request. The bridge captured it from the runtime's
  // `permission.updated` event; here a human's approve/reject is relayed back so the gated
  // tool either runs once or is aborted. This is the only path past the approval gate.
  app.post<{ Params: { requestID: string } }>(
    "/api/approvals/:requestID",
    async (req, reply) => {
      if (!deps.approvals) {
        return reply.code(503).send({ error: "approval gate unavailable" });
      }

      const parsed = ApprovalDecisionSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "invalid approval decision", details: parsed.error.issues });
      }

      try {
        const result = await deps.approvals.reply(
          req.params.requestID,
          parsed.data.action,
        );
        return reply.code(200).send(result);
      } catch (err) {
        if (err instanceof UnknownApprovalError) {
          return reply.code(404).send({ error: err.message });
        }
        if (err instanceof ApprovalReplyError) {
          return reply.code(502).send({ error: err.message });
        }
        throw err;
      }
    },
  );

  return app;
}
