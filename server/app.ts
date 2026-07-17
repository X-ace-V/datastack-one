import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { HealthStatusSchema, type HealthStatus } from "./core/types.js";
import { ApprovalDecisionSchema } from "./core/approvals.js";
import { CreateProjectRequestSchema } from "./core/projects.js";
import {
  ChatRequestSchema,
  CreateSessionRequestSchema,
  RenameSessionRequestSchema,
  SessionModelError,
} from "./core/sessions.js";
import { ProfileRequestSchema } from "./core/profile.js";
import { RulesInputSchema } from "./core/artifacts.js";
import { isCsvFilename } from "./core/sources.js";
import {
  EventsQuerySchema,
  formatSseFrame,
  parseLastEventId,
} from "./core/events.js";
import { listModels, type ModelsClient } from "./opencode/models.js";
import type { WarehouseStore } from "./store/duckdb.js";
import { getProject, insertProject, listProjects } from "./store/projects.js";
import {
  getSource,
  insertSource,
  listSources,
  updateSourceRowCount,
} from "./store/sources.js";
import { ServedQuerySchema, servedCsvFilename } from "./core/serving.js";
import { getServedTable, listServedTables } from "./store/serving.js";
import {
  ServedExportMissingError,
  openServedCsv,
  readServedData,
} from "./serving/reader.js";
import { profileSource } from "./tools/profile.js";
import { DEFAULT_ARTIFACTS_DIR, writeArtifact } from "./tools/rules.js";
import { getLatestArtifactByKind } from "./store/artifacts.js";
import { DEFAULT_UPLOADS_DIR, saveUpload } from "./store/uploads.js";
import {
  ApprovalReplyError,
  UnknownApprovalError,
  type ApprovalGate,
} from "./opencode/approvals.js";
import type { EventHub } from "./opencode/hub.js";
import { SessionManager, SessionRuntimeError } from "./opencode/sessions.js";

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
   * Approval gate holding pending permission requests (FR10). Absent → the approvals route
   * reports 503, since a health-only boot has no runtime to approve against.
   */
  approvals?: ApprovalGate;
  /**
   * Metadata store backing the project routes (FR1). Absent → the project routes report
   * 503, since a health-only boot has no warehouse to persist to.
   */
  store?: WarehouseStore;
  /**
   * SessionManager backing the chat-session routes (FR1). It orchestrates the OpenCode
   * runtime and the `platform` store, so a health-only boot (no runtime) leaves it absent
   * and the session routes report 503.
   */
  sessions?: SessionManager;
  /**
   * Event hub fanning normalized runtime events to the `GET /api/events` SSE stream (FR3).
   * Absent → the events route reports 503, since a health-only boot has no runtime stream.
   */
  events?: EventHub;
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

  // FR1: create a chat session. Opens an OpenCode session and persists it under its id via
  // the SessionManager. Body (both fields optional) is validated against the shared contract
  // (400); a runtime failure to open the OpenCode session is a 502 (nothing is persisted).
  // On success the persisted row — with its OpenCode id, title, and null-or-chosen model — is
  // returned with 201. Status map: 503 unwired, 400 bad body, 502 runtime, 201 created.
  app.post("/api/sessions", async (req, reply) => {
    if (!deps.sessions) {
      return reply.code(503).send({ error: "session manager unavailable" });
    }

    const parsed = CreateSessionRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid session", details: parsed.error.issues });
    }

    try {
      const session = await deps.sessions.create(parsed.data);
      return reply.code(201).send(session);
    } catch (err) {
      if (err instanceof SessionRuntimeError) {
        return reply.code(502).send({ error: err.message });
      }
      throw err;
    }
  });

  // FR1: list all chat sessions, most recently active first, for the sidebar (V2.3).
  // Status map: 503 unwired, 200 with the list.
  app.get("/api/sessions", async (_req, reply) => {
    if (!deps.sessions) {
      return reply.code(503).send({ error: "session manager unavailable" });
    }
    return reply.code(200).send({ sessions: await deps.sessions.list() });
  });

  // FR1: fetch a single session together with its ordered message history — the shape a
  // reopen needs to restore the transcript in one call. Status map: 503 unwired, 404 unknown
  // session, 200 the session with its `messages`.
  app.get<{ Params: { id: string } }>(
    "/api/sessions/:id",
    async (req, reply) => {
      if (!deps.sessions) {
        return reply.code(503).send({ error: "session manager unavailable" });
      }
      const session = await deps.sessions.get(req.params.id);
      if (!session) {
        return reply.code(404).send({ error: "session not found" });
      }
      return reply.code(200).send(session);
    },
  );

  // FR1: rename a session. The title is required (400 otherwise); the manager checks the
  // store before touching the runtime, so an unknown id is a clean 404 that never hits
  // OpenCode. A runtime failure to rename is a 502. Status map: 503 unwired, 400 bad body,
  // 404 unknown, 502 runtime, 200 the updated session.
  app.patch<{ Params: { id: string } }>(
    "/api/sessions/:id",
    async (req, reply) => {
      if (!deps.sessions) {
        return reply.code(503).send({ error: "session manager unavailable" });
      }

      const parsed = RenameSessionRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "invalid rename", details: parsed.error.issues });
      }

      try {
        const session = await deps.sessions.rename(req.params.id, parsed.data.title);
        if (!session) {
          return reply.code(404).send({ error: "session not found" });
        }
        return reply.code(200).send(session);
      } catch (err) {
        if (err instanceof SessionRuntimeError) {
          return reply.code(502).send({ error: err.message });
        }
        throw err;
      }
    },
  );

  // FR1: delete a session and its entire message history. The manager checks the store first,
  // so an unknown id is a 404 that never hits the runtime; a runtime failure to delete is a
  // 502. On success there is nothing to return — 204 No Content. Status map: 503 unwired,
  // 404 unknown, 502 runtime, 204 deleted.
  app.delete<{ Params: { id: string } }>(
    "/api/sessions/:id",
    async (req, reply) => {
      if (!deps.sessions) {
        return reply.code(503).send({ error: "session manager unavailable" });
      }

      try {
        const existed = await deps.sessions.delete(req.params.id);
        if (!existed) {
          return reply.code(404).send({ error: "session not found" });
        }
        return reply.code(204).send();
      } catch (err) {
        if (err instanceof SessionRuntimeError) {
          return reply.code(502).send({ error: err.message });
        }
        throw err;
      }
    },
  );

  // FR2: send a natural-language turn to a session. The user's prompt is validated (400) and
  // persisted, then fired at the agent runtime; the route returns 202 immediately with the
  // persisted user message while the assistant's reasoning/tool-calls/reply stream over SSE.
  // The manager checks the store before touching the runtime, so an unknown id is a clean 404;
  // a malformed model ref is a 400. Status map: 503 unwired, 400 bad body/model, 404 unknown,
  // 202 accepted (the persisted user turn).
  app.post<{ Params: { id: string } }>(
    "/api/sessions/:id/chat",
    async (req, reply) => {
      if (!deps.sessions) {
        return reply.code(503).send({ error: "session manager unavailable" });
      }

      const parsed = ChatRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "invalid chat turn", details: parsed.error.issues });
      }

      try {
        const message = await deps.sessions.chat(req.params.id, parsed.data);
        if (!message) {
          return reply.code(404).send({ error: "session not found" });
        }
        return reply.code(202).send(message);
      } catch (err) {
        if (err instanceof SessionModelError) {
          return reply.code(400).send({ error: err.message });
        }
        throw err;
      }
    },
  );

  // FR2: cancel the in-flight turn on a session via `session.abort`. The manager checks the
  // store before touching the runtime, so an unknown id is a clean 404; a runtime failure to
  // abort is a 502. Status map: 503 unwired, 404 unknown, 502 runtime, 200 cancelled.
  app.post<{ Params: { id: string } }>(
    "/api/sessions/:id/cancel",
    async (req, reply) => {
      if (!deps.sessions) {
        return reply.code(503).send({ error: "session manager unavailable" });
      }

      try {
        const cancelled = await deps.sessions.cancel(req.params.id);
        if (!cancelled) {
          return reply.code(404).send({ error: "session not found" });
        }
        return reply.code(200).send({ status: "cancelled" });
      } catch (err) {
        if (err instanceof SessionRuntimeError) {
          return reply.code(502).send({ error: err.message });
        }
        throw err;
      }
    },
  );

  // FR3: the chat event stream. One long-lived SSE connection relays the normalized runtime
  // events (assistant text/reasoning deltas, tool cards with status, turn idle/error) that the
  // event hub sequences. `?sessionId` scopes the stream to one session (per-session routing);
  // `?lastSeq` (or the SSE `Last-Event-ID` header on an automatic reconnect) replays the backlog
  // after that sequence number before the live stream resumes, so a dropped connection catches
  // up without gap or duplicate. Each frame's `id:` is the seq a client echoes back to resume.
  // The response is hijacked (Fastify's reply lifecycle can't model an endless stream) and the
  // subscription is dropped when the client disconnects. Status map: 503 unwired, 400 bad query,
  // 200 the stream.
  app.get<{ Querystring: unknown }>("/api/events", (req, reply) => {
    if (!deps.events) {
      return reply.code(503).send({ error: "event stream unavailable" });
    }

    const parsed = EventsQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid events query", details: parsed.error.issues });
    }

    const header = req.headers["last-event-id"];
    const lastSeq =
      parsed.data.lastSeq ??
      parseLastEventId(typeof header === "string" ? header : undefined);

    // Take over the socket: write SSE headers, prime the stream with a comment so proxies
    // flush, then push each sequenced event as it arrives.
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    raw.write(": connected\n\n");

    const unsubscribe = deps.events.subscribe(
      ({ seq, event }) => {
        raw.write(formatSseFrame({ id: String(seq), event: event.kind, data: event }));
      },
      { sessionId: parsed.data.sessionId, lastSeq },
    );

    req.raw.on("close", unsubscribe);
    return reply;
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

  // FR10 (T5.4): list the tables a project has published, newest first, so the Serve step can
  // resolve a project to its generated endpoints. The registry is keyed by served *name* (that
  // name is the endpoint URL), while the wizard carries a project — this is the join between the
  // two. Each row carries its own `/api/serve/:name` and `.csv` URLs, so the page needs no further
  // lookup to render the endpoint or the download link. An empty list means the project has not
  // published yet (its pipeline has not reached a successful publish stage), which is a normal
  // state, not an error. Status map: 503 unwired store, 404 unknown project, 200 with the list.
  app.get<{ Params: { id: string } }>(
    "/api/projects/:id/served",
    async (req, reply) => {
      if (!deps.store) {
        return reply.code(503).send({ error: "served table store unavailable" });
      }
      const project = await getProject(deps.store, req.params.id);
      if (!project) {
        return reply.code(404).send({ error: "project not found" });
      }
      return reply.code(200).send({ served: await listServedTables(deps.store, project.id) });
    },
  );

  // FR10 (T5.3): the generated REST endpoint — query the table published under `:name`. The
  // publish stage registered the name; this resolves it back to its published export and returns
  // a page of rows with the columns and the total row count. `:name` is looked up exactly as
  // requested (bound as a parameter, never sanitized here): the registry only ever holds
  // sanitized names, so an unregistered spelling honestly misses rather than being rewritten
  // into a hit. Status map: 503 unwired store, 400 bad page, 404 nothing served at that name,
  // 410 registered but its export is gone, 200 the data.
  app.get<{ Params: { name: string }; Querystring: unknown }>(
    "/api/serve/:name",
    async (req, reply) => {
      if (!deps.store) {
        return reply.code(503).send({ error: "served table store unavailable" });
      }

      const parsed = ServedQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "invalid serve query", details: parsed.error.issues });
      }

      const served = await getServedTable(deps.store, req.params.name);
      if (!served) {
        return reply
          .code(404)
          .send({ error: `no table is served at "${req.params.name}"` });
      }

      try {
        return reply.code(200).send(await readServedData(deps.store, served, parsed.data));
      } catch (err) {
        if (err instanceof ServedExportMissingError) {
          return reply.code(410).send({ error: err.message });
        }
        throw err;
      }
    },
  );

  // FR10 (T5.3): download the table published under `:name` as CSV. Serves the export the publish
  // stage generated and verified — the same bytes the JSON endpoint above reads — streamed with an
  // attachment disposition so a browser saves it as a file. The `.csv` suffix is a static part of
  // this route, so it is matched ahead of the parametric route above and never reaches it as part
  // of the name; the filename needs no escaping because a served name is sanitized at publish time
  // to `[A-Za-z0-9_-]`. Status map matches the JSON endpoint.
  app.get<{ Params: { name: string } }>("/api/serve/:name.csv", async (req, reply) => {
    if (!deps.store) {
      return reply.code(503).send({ error: "served table store unavailable" });
    }

    const served = await getServedTable(deps.store, req.params.name);
    if (!served) {
      return reply.code(404).send({ error: `no table is served at "${req.params.name}"` });
    }

    try {
      const { stream, size } = await openServedCsv(served);
      return reply
        .code(200)
        .header("content-type", "text/csv; charset=utf-8")
        .header("content-length", size)
        .header(
          "content-disposition",
          `attachment; filename="${servedCsvFilename(served.name)}"`,
        )
        .send(stream);
    } catch (err) {
      if (err instanceof ServedExportMissingError) {
        return reply.code(410).send({ error: err.message });
      }
      throw err;
    }
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
