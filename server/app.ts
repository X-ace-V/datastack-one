import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { HealthStatusSchema, type HealthStatus } from "./core/types.js";
import { ApprovalDecisionSchema } from "./core/approvals.js";
import { CreateProjectRequestSchema } from "./core/projects.js";
import { isCsvFilename } from "./core/sources.js";
import { listModels, type ModelsClient } from "./opencode/models.js";
import type { RunBridge } from "./opencode/bridge.js";
import type { WarehouseStore } from "./store/duckdb.js";
import { getProject, insertProject, listProjects } from "./store/projects.js";
import { insertSource, listSources } from "./store/sources.js";
import { DEFAULT_UPLOADS_DIR, saveUpload } from "./store/uploads.js";
import {
  ApprovalReplyError,
  UnknownApprovalError,
  type ApprovalGate,
} from "./opencode/approvals.js";

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
   * Metadata store backing the project routes (FR1). Absent → the project routes report
   * 503, since a health-only boot has no warehouse to persist to.
   */
  store?: WarehouseStore;
  /**
   * Directory uploaded CSVs are written to (FR2). Defaults to {@link DEFAULT_UPLOADS_DIR};
   * tests override it with a tmp dir so they never touch the repo's `data/`.
   */
  uploadsDir?: string;
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
