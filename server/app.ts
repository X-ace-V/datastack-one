import { randomUUID } from "node:crypto";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { HealthStatusSchema, type HealthStatus } from "./core/types.js";
import { ApprovalDecisionSchema } from "./core/approvals.js";
import { CreateProjectRequestSchema } from "./core/projects.js";
import {
  ChatRequestSchema,
  CreateSessionRequestSchema,
  UpdateSessionRequestSchema,
  SessionModelError,
  SessionAttachmentError,
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
import {
  ServedQuerySchema,
  servedCsvFilename,
  sessionScopedServedName,
} from "./core/serving.js";
import { getServedTable, listServedTables } from "./store/serving.js";
import {
  ServedExportMissingError,
  openServedCsv,
  readServedData,
} from "./serving/reader.js";
import { profileSource } from "./tools/profile.js";
import { loadDataRowCount } from "./tools/data-source.js";
import { listSourcesForSession } from "./tools/list-sources.js";
import { runQuery } from "./tools/query.js";
import { DEFAULT_LANDING_DIR, landParquet } from "./tools/land.js";
import { loadWarehouse } from "./tools/warehouse.js";
import { runTransform } from "./tools/transform.js";
import { DEFAULT_SERVING_DIR, publishServing } from "./tools/serve.js";
import { safeDatasetName } from "./core/landing.js";
import {
  clearSessionSources,
  clearSessionSourcesByOrigin,
  getSessionSource,
  listSessionSources,
  registerSessionSource,
} from "./store/session-sources.js";
import {
  attachedTableName,
  POSTGRES_SOURCE_KIND,
  sourceNameFromFilename,
  toSessionSourceView,
} from "./core/session-sources.js";
import { getSession } from "./store/sessions.js";
import { CreateConnectionRequestSchema, toConnectionView } from "./core/connections.js";
import {
  addConnection,
  deleteConnection,
  getStoredConnection,
  listConnections,
} from "./store/connections.js";
import type { ConnectionTester } from "./connections/postgres.js";
import type { PostgresAttacher } from "./connections/attach.js";
import { listSessionLineage, recordLineageEvent } from "./store/session-lineage.js";
import type { LineageStatus } from "./core/session-lineage.js";
import {
  ListSourcesRequestSchema,
  ProfileSourceRequestSchema,
  RunQueryRequestSchema,
  RunDqCheckRequestSchema,
  LandParquetRequestSchema,
  LoadWarehouseRequestSchema,
  RunTransformRequestSchema,
  PublishServingRequestSchema,
  AttachSourceRequestSchema,
} from "./core/tool-io.js";
import { DqSpecSchema, DQ_TARGET_TABLE } from "./core/dq.js";
import { runDqCheck } from "./tools/dq.js";
import type { SessionDqGate } from "./opencode/session-dq.js";
import { DEFAULT_ARTIFACTS_DIR, writeArtifact } from "./tools/rules.js";
import { getLatestArtifactByKind } from "./store/artifacts.js";
import { DEFAULT_UPLOADS_DIR, saveUpload, saveSessionUpload } from "./store/uploads.js";
import {
  ApprovalReplyError,
  UnknownApprovalError,
  type ApprovalGate,
} from "./opencode/approvals.js";
import type { ToolApprovalGate } from "./opencode/tool-approvals.js";
import type { EventHub } from "./opencode/hub.js";
import { SessionManager, SessionRuntimeError } from "./opencode/sessions.js";
import type { SessionWarehouseRegistry } from "./store/session-warehouses.js";
import {
  ConnectFolderRequestSchema,
  isQueryableWorkspaceKind,
  isSensitiveWorkspaceName,
  ListWorkspaceFilesRequestSchema,
  ReadWorkspaceFileRequestSchema,
  WriteWorkspaceFileRequestSchema,
  workspaceFileKind,
  type WorkspaceFileKind,
  type WorkspaceFile,
} from "./core/workspace.js";
import type { LocalWorkspaceService } from "./workspace/local.js";
import {
  connectSessionFolder,
  disconnectSessionFolder,
  getSessionFolder,
} from "./store/session-folders.js";
import { sourceNameFromRelativePath } from "./core/session-sources.js";

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
   * Approval gate holding pending OpenCode permission requests for built-in surfaces
   * (bash/edit/webfetch) (FR10). Absent → the approvals route falls back to the tool gate.
   */
  approvals?: ApprovalGate;
  /**
   * Approval gate for the custom write tools (V4.1, FR8/FR10). OpenCode does not gate plugin
   * tools, so each write route pauses on this gate before executing. Absent → the write routes
   * report 503 (a write cannot run without a gate) and the approvals route falls back to
   * {@link ServerDeps.approvals}.
   */
  toolApprovals?: ToolApprovalGate;
  /**
   * Per-session data-quality gate (V4.3, FR9). `run_dq_check` records each run here and
   * `publish_serving` consults it: a session whose most recent DQ run failed cannot publish.
   * Absent → nothing records or blocks, so `run_dq_check` still runs but does not gate publish
   * (a health-only boot with no runtime state).
   */
  dqGate?: SessionDqGate;
  /**
   * Metadata store backing the project routes (FR1). Absent → the project routes report
   * 503, since a health-only boot has no warehouse to persist to.
   */
  store?: WarehouseStore;
  /** Isolated DuckDB execution stores. Omitted in narrow tests, which fall back to `store`. */
  sessionWarehouses?: SessionWarehouseRegistry;
  /** Secure local-folder browser/indexer. Only wired for the localhost application boot. */
  workspace?: LocalWorkspaceService;
  /**
   * Probes whether a registered connection URL is reachable, backing
   * `POST /api/connections/:name/test` (FR5). Injected so route tests supply a deterministic,
   * offline stub while the real boot wires the DuckDB Postgres attach probe. Absent → the
   * test-connection route reports 503 (add/list/delete still work off the store alone).
   */
  testConnection?: ConnectionTester;
  /**
   * Attaches a registered Postgres connection into the warehouse read-only, backing the
   * ask-gated `attach_source` tool (V5.2, FR5b). Injected so route tests supply an offline stub
   * while the real boot wires the DuckDB Postgres ATTACH. Absent → `attach_source` reports 503
   * (the other tool routes are unaffected).
   */
  attachSource?: PostgresAttacher;
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
  /**
   * Root the `land_parquet` write tool lands Parquet under (FR8). Namespaced per session.
   * Defaults to {@link DEFAULT_LANDING_DIR}; tests override it with a tmp dir.
   */
  landingDir?: string;
  /**
   * Root the `publish_serving` write tool exports CSV under (FR8/FR11). Namespaced per session.
   * Defaults to {@link DEFAULT_SERVING_DIR}; tests override it with a tmp dir.
   */
  servingDir?: string;
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
  const landingDir = deps.landingDir ?? DEFAULT_LANDING_DIR;
  const servingDir = deps.servingDir ?? DEFAULT_SERVING_DIR;

  /**
   * Resolve the data-plane store for one chat. The global store remains the control plane; when
   * an isolated registry is wired, mirror only this session's path-safe source registrations into
   * its private warehouse before a tool runs.
   */
  async function executionStore(sessionId: string): Promise<WarehouseStore> {
    if (!deps.store) throw new Error("session source store unavailable");
    if (!deps.sessionWarehouses) return deps.store;
    const isolated = await deps.sessionWarehouses.get(sessionId);
    const sources = await listSessionSources(deps.store, sessionId);
    await clearSessionSources(isolated, sessionId);
    for (const source of sources) {
      await registerSessionSource(isolated, {
        sessionId,
        name: source.name,
        kind: source.kind,
        path: source.path,
        origin: source.origin,
        relativePath: source.relativePath,
        rowCount: source.rowCount,
      });
    }
    return isolated;
  }

  async function indexConnectedFolder(
    sessionId: string,
    folderPath: string,
  ): Promise<WorkspaceFile[]> {
    if (!deps.store || !deps.workspace) throw new Error("folder workspace unavailable");
    const files = await deps.workspace.scan(folderPath);
    await clearSessionSourcesByOrigin(deps.store, sessionId, "folder");
    for (const file of files) {
      if (!file.queryable) continue;
      await registerSessionSource(deps.store, {
        sessionId,
        name: file.sourceName ?? sourceNameFromRelativePath(file.path),
        kind: file.kind,
        path: join(folderPath, file.path),
        origin: "folder",
        relativePath: file.path,
      });
    }
    return files;
  }

  // FR2: accept CSV uploads as multipart/form-data. Registered for the whole app; only the
  // source-upload route reads a file, and the size cap guards the disk.
  app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });

  // Local filesystem endpoints are more sensitive than ordinary API reads. Browsers may call
  // them only from a loopback origin; same-origin server/plugin/test requests carry no Origin and
  // remain valid. `Sec-Fetch-Site: cross-site` is rejected as an additional CSRF guard.
  app.addHook("onRequest", async (req, reply) => {
    const filesystemRoute =
      req.url.startsWith("/api/folders") ||
      /\/api\/sessions\/[^/]+\/folder(?:[/?]|$)/.test(req.url) ||
      (req.method === "POST" && req.url.split("?", 1)[0] === "/api/sessions");
    if (!filesystemRoute) return;
    if (req.headers["sec-fetch-site"] === "cross-site") {
      return reply.code(403).send({ error: "cross-site folder access is not allowed" });
    }
    const origin = req.headers.origin;
    if (!origin) return;
    try {
      const hostname = new URL(origin).hostname;
      if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname)) {
        return reply.code(403).send({ error: "folder access requires a localhost origin" });
      }
    } catch {
      return reply.code(403).send({ error: "invalid request origin" });
    }
  });

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

  // FR1: create a chat session. When `folderPath` is supplied, resolve it through the secure
  // local workspace service first, then create OpenCode IN that directory. OpenCode session
  // directories are immutable, so this is the only honest way to get Claude Code/Codex-style
  // folder semantics: choosing another folder creates another independent chat.
  // The body is validated against the shared contract
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

    let resolvedFolder: { name: string; path: string } | null = null;
    if (parsed.data.folderPath) {
      if (!deps.store || !deps.workspace) {
        return reply.code(503).send({ error: "folder workspace unavailable" });
      }
      try {
        resolvedFolder = await deps.workspace.resolveFolder(parsed.data.folderPath);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(400).send({ error: message });
      }
    }

    try {
      const session = await deps.sessions.create({
        ...parsed.data,
        ...(resolvedFolder ? { folderPath: resolvedFolder.path } : {}),
      });
      if (resolvedFolder && deps.store) {
        try {
          await indexConnectedFolder(session.id, resolvedFolder.path);
          await connectSessionFolder(deps.store, {
            sessionId: session.id,
            ...resolvedFolder,
            workspaceRoot: true,
          });
        } catch (err) {
          // Do not leave a session that claims to be folder-rooted when its workspace could not
          // be registered. The runtime and all platform rows are rolled back together.
          await deps.sessions.delete(session.id).catch(() => {});
          throw err;
        }
      }
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

  // Recover OpenCode's live busy/idle/retry state after a browser reload. Runtime events keep
  // the map current afterward; this snapshot prevents background work from looking idle merely
  // because the page connected after the busy event was emitted.
  app.get("/api/sessions/status", async (_req, reply) => {
    if (!deps.sessions) {
      return reply.code(503).send({ error: "session manager unavailable" });
    }
    try {
      return reply.code(200).send({ statuses: await deps.sessions.status() });
    } catch (err) {
      if (err instanceof SessionRuntimeError) {
        return reply.code(502).send({ error: err.message });
      }
      throw err;
    }
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

  // FR12: a session's lineage/audit trail — the write tool calls it executed, the approvals a
  // human answered, and the DQ results, in `seq` order (V4.4). Reads straight from the `platform`
  // store (the persistence, not the live in-memory gates), so the trail survives a restart and a
  // reopened session. This is the audit PRD §5 verifies "100% of writes were approved" against.
  // Status map: 503 no store, 404 unknown session, 200 with `{ lineage }`.
  app.get<{ Params: { id: string } }>(
    "/api/sessions/:id/lineage",
    async (req, reply) => {
      if (!deps.store) {
        return reply.code(503).send({ error: "lineage store unavailable" });
      }
      const session = await getSession(deps.store, req.params.id);
      if (!session) {
        return reply.code(404).send({ error: "session not found" });
      }
      const lineage = await listSessionLineage(deps.store, req.params.id);
      return reply.code(200).send({ lineage });
    },
  );

  // FR1/FR11: update a session — rename it and/or set its per-session model (V6.1). At least
  // one of `title`/`model` is required (400 otherwise); the manager checks the store before
  // touching the runtime, so an unknown id is a clean 404 that never hits OpenCode. A rename
  // hits the runtime (502 on failure); a model change is store-only metadata. A malformed
  // model ref is a 400 (SessionModelError). Status map: 503 unwired, 400 bad body/model,
  // 404 unknown, 502 runtime, 200 the updated session.
  app.patch<{ Params: { id: string } }>(
    "/api/sessions/:id",
    async (req, reply) => {
      if (!deps.sessions) {
        return reply.code(503).send({ error: "session manager unavailable" });
      }

      const parsed = UpdateSessionRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "invalid update", details: parsed.error.issues });
      }

      try {
        // Apply each provided field; a missing session on either step is a clean 404. The last
        // applied step's row is the response, so a combined title+model patch returns both.
        let session = null;
        if (parsed.data.title !== undefined) {
          session = await deps.sessions.rename(req.params.id, parsed.data.title);
          if (!session) {
            return reply.code(404).send({ error: "session not found" });
          }
        }
        if (parsed.data.model !== undefined) {
          session = await deps.sessions.setModel(req.params.id, parsed.data.model);
          if (!session) {
            return reply.code(404).send({ error: "session not found" });
          }
        }
        return reply.code(200).send(session);
      } catch (err) {
        if (err instanceof SessionModelError) {
          return reply.code(400).send({ error: err.message });
        }
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
        await deps.sessionWarehouses?.delete(req.params.id);
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
        if (err instanceof SessionModelError || err instanceof SessionAttachmentError) {
          return reply.code(400).send({ error: err.message });
        }
        throw err;
      }
    },
  );

  // Secure server-backed folder picker for the localhost web UI. Browsing is constrained by
  // LocalWorkspaceService's configured roots; only directory names/paths are returned here.
  app.get<{ Querystring: { path?: string } }>("/api/folders", async (req, reply) => {
    if (!deps.workspace) {
      return reply.code(503).send({ error: "folder workspace unavailable" });
    }
    try {
      return reply.code(200).send(await deps.workspace.browse(req.query?.path));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: message });
    }
  });

  app.get<{ Params: { id: string } }>("/api/sessions/:id/folder", async (req, reply) => {
    if (!deps.store || !deps.workspace) {
      return reply.code(503).send({ error: "folder workspace unavailable" });
    }
    const session = await getSession(deps.store, req.params.id);
    if (!session) return reply.code(404).send({ error: "session not found" });
    const folder = await getSessionFolder(deps.store, req.params.id);
    if (!folder) return reply.code(200).send({ folder: null, files: [] });
    try {
      return reply.code(200).send({ folder, files: await deps.workspace.scan(folder.path) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(410).send({ error: message, folder, files: [] });
    }
  });

  app.post<{ Params: { id: string } }>("/api/sessions/:id/folder", async (req, reply) => {
    if (!deps.store) {
      return reply.code(503).send({ error: "folder workspace unavailable" });
    }
    const parsed = ConnectFolderRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid folder", details: parsed.error.issues });
    }
    const session = await getSession(deps.store, req.params.id);
    if (!session) return reply.code(404).send({ error: "session not found" });
    return reply.code(409).send({
      error:
        "an OpenCode session cannot change working directory; start a new session with folderPath",
    });
  });

  app.post<{ Params: { id: string } }>(
    "/api/sessions/:id/folder/refresh",
    async (req, reply) => {
      if (!deps.store || !deps.workspace) {
        return reply.code(503).send({ error: "folder workspace unavailable" });
      }
      const folder = await getSessionFolder(deps.store, req.params.id);
      if (!folder) return reply.code(404).send({ error: "folder not connected" });
      try {
        const files = await indexConnectedFolder(req.params.id, folder.path);
        return reply.code(200).send({ folder, files });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(400).send({ error: message });
      }
    },
  );

  app.delete<{ Params: { id: string } }>("/api/sessions/:id/folder", async (req, reply) => {
    if (!deps.store) return reply.code(503).send({ error: "folder workspace unavailable" });
    const session = await getSession(deps.store, req.params.id);
    if (!session) return reply.code(404).send({ error: "session not found" });
    const folder = await getSessionFolder(deps.store, req.params.id);
    if (folder?.workspaceRoot) {
      return reply.code(409).send({
        error: "a session workspace is immutable; switch to or create another session",
      });
    }
    await clearSessionSourcesByOrigin(deps.store, req.params.id, "folder");
    await disconnectSessionFolder(deps.store, req.params.id);
    return reply.code(204).send();
  });

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

  /** List path-free source registrations for composer chips and connected-folder feedback. */
  app.get<{ Params: { id: string } }>("/api/sessions/:id/sources", async (req, reply) => {
    if (!deps.store) {
      return reply.code(503).send({ error: "session source store unavailable" });
    }
    const session = await getSession(deps.store, req.params.id);
    if (!session) return reply.code(404).send({ error: "session not found" });
    const sources = await listSessionSources(deps.store, req.params.id);
    return reply.code(200).send({ sources: sources.map(toSessionSourceView) });
  });

  // Upload a data/project file into a chat session. Multiple composer selections use one request
  // per file, so each upload is independently retryable and remains session-owned.
  // `data/uploads/<sessionId>/` and is registered in `platform.session_sources` under a name
  // derived from the filename, so the agent's `list_sources`/`profile_source` tools see it — the
  // agent addresses it by that name; the on-disk path is resolved backend-side and never handed
  // to the model (FR5b). The CSV is loaded in DuckDB once here so the row count is known
  // immediately and a file DuckDB cannot read is rejected up front. Registering re-uses the
  // (session_id, name) upsert, so re-uploading the same filename replaces the source in place.
  // Status map: 503 unwired store, 400 non-multipart/missing/non-csv/empty/oversize, 404 unknown
  // session, 422 unreadable CSV, 201 the registered source (path withheld).
  app.post<{ Params: { id: string } }>(
    "/api/sessions/:id/sources",
    async (req, reply) => {
      if (!deps.store) {
        return reply.code(503).send({ error: "session source store unavailable" });
      }
      if (!req.isMultipart()) {
        return reply.code(400).send({ error: "expected a multipart/form-data upload" });
      }

      const session = await getSession(deps.store, req.params.id);
      if (!session) {
        return reply.code(404).send({ error: "session not found" });
      }

      const data = await req.file();
      if (!data) return reply.code(400).send({ error: "a file is required" });
      const kind = workspaceFileKind(data.filename);
      if (!kind) {
        return reply.code(400).send({
          error: "supported files: CSV, TSV, JSON/JSONL, Parquet, SQL, YAML, Markdown, and text",
        });
      }
      if (isSensitiveWorkspaceName(data.filename)) {
        return reply.code(400).send({
          error: "credential and environment files cannot be attached to a chat",
        });
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
      const path = await saveSessionUpload({
        dir: uploadsDir,
        sessionId: session.id,
        sourceId,
        originalFilename: data.filename,
        content,
      });

      // Confirm the file is genuinely loadable in DuckDB and capture its row count, so
      // `list_sources` shows a count at once and an unreadable file fails here, not later.
      let rowCount: number | null = null;
      if (isQueryableWorkspaceKind(kind as WorkspaceFileKind)) {
        try {
          rowCount = await loadDataRowCount(
            await executionStore(session.id),
            path,
            kind,
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return reply.code(422).send({ error: `could not load ${kind}: ${message}` });
        }
      }

      const source = await registerSessionSource(deps.store, {
        sessionId: session.id,
        name: sourceNameFromFilename(data.filename),
        path,
        kind,
        origin: "upload",
        rowCount,
      });
      return reply.code(201).send({ source: toSessionSourceView(source) });
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

  // FR5: register a database connection (Settings → Connections). This is the ONLY route a
  // credentialed URL is entered on. The body is validated (a bad name or a non-postgres URL is a
  // 400); the URL is bound as a parameter and persisted in the gitignored warehouse. The 201
  // response carries the secret-free VIEW (name/type/createdAt) — the url is never echoed back.
  // Status map: 503 unwired, 400 bad body, 201 the registered connection.
  app.post("/api/connections", async (req, reply) => {
    if (!deps.store) {
      return reply.code(503).send({ error: "connection store unavailable" });
    }

    const parsed = CreateConnectionRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid connection", details: parsed.error.issues });
    }

    const stored = await addConnection(deps.store, parsed.data);
    return reply.code(201).send({ connection: toConnectionView(stored) });
  });

  // FR5: list registered connections. Returns only the secret-free views (name/type/createdAt);
  // the store read never selects the url, so this response cannot carry a credential. Status
  // map: 503 unwired, 200 the connections.
  app.get("/api/connections", async (_req, reply) => {
    if (!deps.store) {
      return reply.code(503).send({ error: "connection store unavailable" });
    }
    return reply.code(200).send({ connections: await listConnections(deps.store) });
  });

  // FR5: delete a registered connection by name. Status map: 503 unwired, 404 unknown name,
  // 204 deleted.
  app.delete<{ Params: { name: string } }>(
    "/api/connections/:name",
    async (req, reply) => {
      if (!deps.store) {
        return reply.code(503).send({ error: "connection store unavailable" });
      }
      const existed = await deleteConnection(deps.store, req.params.name);
      if (!existed) {
        return reply.code(404).send({ error: "connection not found" });
      }
      return reply.code(204).send();
    },
  );

  // FR5: test a registered connection. The backend resolves name → the stored (secret) URL and
  // probes it read-only; the response carries only {ok, error} with any credential scrubbed from
  // the failure message — the URL never leaves the backend. Status map: 503 unwired (no store or
  // no tester), 404 unknown name, 200 the probe result (ok true or false).
  app.post<{ Params: { name: string } }>(
    "/api/connections/:name/test",
    async (req, reply) => {
      if (!deps.store || !deps.testConnection) {
        return reply.code(503).send({ error: "connection tester unavailable" });
      }
      const stored = await getStoredConnection(deps.store, req.params.name);
      if (!stored) {
        return reply.code(404).send({ error: "connection not found" });
      }
      const result = await deps.testConnection(stored.url, stored.type);
      return reply.code(200).send({ result });
    },
  );

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

  // FR8/FR10: resolve a pending approval — the single path a human's approve/reject reaches a
  // paused write. A request is held by one of two gates: the write-tool gate (V4.1) for the
  // custom data-eng tools, or the OpenCode permission gate for built-in surfaces (bash/edit/
  // webfetch). We try the tool gate first (it owns the write path), then fall back. Answering
  // the tool gate releases the awaiting write route; answering the OpenCode gate replies to the
  // runtime.
  app.post<{ Params: { requestID: string } }>(
    "/api/approvals/:requestID",
    async (req, reply) => {
      if (!deps.toolApprovals && !deps.approvals) {
        return reply.code(503).send({ error: "approval gate unavailable" });
      }

      const parsed = ApprovalDecisionSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "invalid approval decision", details: parsed.error.issues });
      }

      // The write-tool gate holds this request → answer it and release the paused write route.
      const pending = deps.toolApprovals?.get(req.params.requestID);
      if (pending) {
        // Record the decision in the session lineage BEFORE releasing the write route, so the
        // approval precedes the tool_call in `seq` order — the trail reads "approved, then
        // executed" (FR12, PRD §5 audit). Best-effort when no store is wired (health-only boot).
        if (deps.store) {
          await recordLineageEvent(deps.store, {
            sessionId: pending.sessionID,
            kind: "approval",
            tool: pending.type,
            status: parsed.data.action === "approve" ? "approved" : "rejected",
            detail: { requestID: pending.requestID, metadata: pending.metadata },
          });
        }
        const result = deps.toolApprovals!.reply(req.params.requestID, parsed.data.action);
        return reply.code(200).send(result);
      }

      if (!deps.approvals) {
        return reply.code(404).send({ error: `no pending approval for request "${req.params.requestID}"` });
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

  // FR4/FR6: internal loopback the agent's data tools call (ARCHITECTURE §3.4). The tools run
  // inside OpenCode's own runtime — a separate process with no access to this DuckDB store — so
  // each `execute()` POSTs here and this backend does the store work. These routes are for the
  // in-process plugin only (the app binds to 127.0.0.1); they take a session id + a source
  // **name** and never a raw path/credential, and never return one either (FR5b).

  // `list_sources`: the sources connected to a session, as model-safe views (name + kind +
  // row count, no paths). Status map: 503 unwired store, 400 bad body, 200 with the list.
  app.post("/api/internal/tools/list_sources", async (req, reply) => {
    if (!deps.store) {
      return reply.code(503).send({ error: "session source store unavailable" });
    }
    const parsed = ListSourcesRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid list_sources request", details: parsed.error.issues });
    }
    const sources = await listSourcesForSession(deps.store, parsed.data.sessionID);
    return reply.code(200).send({ sources });
  });

  // Folder-aware read tools expose relative names/content only. Absolute paths remain backend
  // control data and never cross the loopback into the model.
  app.post("/api/internal/tools/list_workspace_files", async (req, reply) => {
    if (!deps.store || !deps.workspace) {
      return reply.code(503).send({ error: "folder workspace unavailable" });
    }
    const parsed = ListWorkspaceFilesRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid list_workspace_files request" });
    }
    const folder = await getSessionFolder(deps.store, parsed.data.sessionID);
    if (!folder) return reply.code(200).send({ folder: null, files: [] });
    try {
      return reply.code(200).send({
        folder: { name: folder.name },
        files: await deps.workspace.scan(folder.path),
      });
    } catch (err) {
      return reply.code(422).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/internal/tools/read_workspace_file", async (req, reply) => {
    if (!deps.store || !deps.workspace) {
      return reply.code(503).send({ error: "folder workspace unavailable" });
    }
    const parsed = ReadWorkspaceFileRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid read_workspace_file request" });
    }
    try {
      // An uploaded text file is addressed by its safe source name. A connected-folder file is
      // addressed by its relative path. Both resolutions stay backend-side.
      const source = await getSessionSource(
        deps.store,
        parsed.data.sessionID,
        parsed.data.path,
      );
      if (source?.origin === "upload") {
        const content = await deps.workspace.readRegisteredFile(source.path, source.kind);
        return reply.code(200).send({ path: source.name, content });
      }
      const folder = await getSessionFolder(deps.store, parsed.data.sessionID);
      if (!folder) return reply.code(404).send({ error: "folder not connected" });
      return reply.code(200).send(
        await deps.workspace.read(folder.path, parsed.data.path),
      );
    } catch (err) {
      return reply.code(422).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // `profile_source`: profile a named source connected to a session (schema, types, row count,
  // null %, candidate keys, date cols). Resolves the name → path backend-side, then runs the
  // read-only profiler. Status map: 503 unwired store, 400 bad body, 404 no source of that name
  // in the session, 422 unreadable CSV, 200 with `{ source, profile }`.
  app.post("/api/internal/tools/profile_source", async (req, reply) => {
    if (!deps.store) {
      return reply.code(503).send({ error: "session source store unavailable" });
    }
    const parsed = ProfileSourceRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid profile_source request", details: parsed.error.issues });
    }

    const source = await getSessionSource(
      deps.store,
      parsed.data.sessionID,
      parsed.data.source,
    );
    if (!source) {
      return reply.code(404).send({ error: "source not found" });
    }

    let profile;
    try {
      profile = await profileSource(
        await executionStore(parsed.data.sessionID),
        source.path,
        source.kind,
      );
    } catch (err) {
      // read_csv_auto failed (missing file, unreadable CSV) — report it rather than 500.
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(422).send({ error: `could not profile source: ${message}` });
    }
    return reply.code(200).send({ source: source.name, profile });
  });

  // `run_query`: run a model-produced read-only SELECT over DuckDB in the context of a session's
  // connected sources (each exposed by name, FR5b/FR7) and return the rows for the data panel.
  // Status map: 503 unwired store, 400 bad body, 422 a query that is not a single read-only SELECT
  // or that DuckDB could not run (so the agent can revise it), 200 with `{ result }`.
  app.post("/api/internal/tools/run_query", async (req, reply) => {
    if (!deps.store) {
      return reply.code(503).send({ error: "session source store unavailable" });
    }
    const parsed = RunQueryRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid run_query request", details: parsed.error.issues });
    }

    let result;
    try {
      result = await runQuery(await executionStore(parsed.data.sessionID), {
        sessionId: parsed.data.sessionID,
        sql: parsed.data.sql,
      });
    } catch (err) {
      // A non-read-only query, a SQL/parse error, or an unreadable source — report it rather
      // than 500 so the agent gets the detail and can rewrite the query.
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(422).send({ error: `could not run query: ${message}` });
    }
    return reply.code(200).send({ result });
  });

  // `run_dq_check`: execute the agent-proposed data-quality checks against the loaded warehouse
  // table and record the outcome on the per-session DQ gate (V4.3, FR9). Read-only — it only runs
  // SELECT counts, so it needs no approval. The checks are assembled into a `DqSpec` (default
  // target `raw.source`) and validated for the ≥3-checks / ≥3-distinct-types invariant here, so a
  // degenerate set is a 422 the agent can act on. A **failing** run blocks a later publish for the
  // session (the block is enforced in the publish route). Status map: 503 unwired store, 400 bad
  // body, 422 a spec that fails the DQ contract, 200 with `{ result }` (pass or fail per check).
  app.post("/api/internal/tools/run_dq_check", async (req, reply) => {
    if (!deps.store) {
      return reply.code(503).send({ error: "session source store unavailable" });
    }
    const parsed = RunDqCheckRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid run_dq_check request", details: parsed.error.issues });
    }

    // Assemble + validate the reviewable spec (≥3 checks covering ≥3 of the four types). A
    // degenerate set (too few checks, no type coverage, a column-less not_null) fails here so the
    // agent gets the specific reason rather than a silent, unhelpful pass.
    const spec = DqSpecSchema.safeParse({
      targetTable: parsed.data.targetTable ?? DQ_TARGET_TABLE,
      checks: parsed.data.checks,
    });
    if (!spec.success) {
      const summary = spec.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ");
      return reply.code(422).send({ error: `invalid data-quality checks: ${summary}` });
    }

    let result;
    try {
      result = await runDqCheck(await executionStore(parsed.data.sessionID), { spec: spec.data });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(422).send({ error: `could not run data-quality checks: ${message}` });
    }
    // Record on the gate so a failing run blocks a later publish for this session (FR9).
    deps.dqGate?.record(parsed.data.sessionID, result);
    // Persist the outcome to the session lineage (FR12, V4.4) so the check that blocked a publish
    // is explained in the audit trail — separate from the in-memory gate, which only holds the
    // latest run for the publish decision.
    await recordLineageEvent(deps.store, {
      sessionId: parsed.data.sessionID,
      kind: "dq_result",
      tool: "run_dq_check",
      status: result.passed ? "passed" : "failed",
      detail: {
        targetTable: result.targetTable,
        passed: result.passed,
        results: result.results,
      },
    });
    return reply.code(200).send({ result });
  });

  // FR8/FR10 write tools. These are the backend half of the four approval-gated write tools.
  // OpenCode does not gate a custom plugin tool, so the pause is enforced HERE: each route opens
  // an inline approval on the tool gate and AWAITS a human's answer before it executes — nothing
  // is written unapproved. A rejected approval returns `{ approved: false }` (200) and performs
  // no write; the plugin turns that into a "denied, nothing written" message. Each route resolves
  // its destination server-side from the session (never a model-sent path, FR5b) and runs the
  // corresponding data-plane tool. Status map: 503 unwired store/gate, 400 bad body, 404 unknown
  // source, 422 a write that could not complete (so the agent gets the detail), 200 with the
  // result (or `{ approved: false }` on rejection).

  /**
   * Pause a write on the inline approval gate: register the pending approval (which surfaces it
   * on the chat SSE stream) and await the human's answer. Resolves `true` when approved.
   */
  async function awaitWriteApproval(
    sessionID: string,
    tool: string,
    metadata: Record<string, unknown>,
  ): Promise<boolean> {
    const { decided } = deps.toolApprovals!.request({ sessionID, tool, metadata });
    return (await decided).status === "approved";
  }

  /**
   * Record a write tool's execution outcome in the session lineage (FR12, V4.4). Called only from
   * the write routes, which have already guarded `deps.store` (503 otherwise). A write's
   * `tool_call` row is written after its approval was answered and its execution attempted, so the
   * trail always shows the approval preceding the execution — the audit PRD §5 verifies.
   */
  async function recordToolCallLineage(
    sessionID: string,
    tool: string,
    status: LineageStatus,
    detail: Record<string, unknown>,
  ): Promise<void> {
    await recordLineageEvent(deps.store!, {
      sessionId: sessionID,
      kind: "tool_call",
      tool,
      status,
      detail,
    });
  }

  // Approval-gated create/replace for text-based SQL/dbt project files in the connected folder.
  // No delete operation is exposed. The model uses a relative path and the backend resolves it.
  app.post("/api/internal/tools/write_workspace_file", async (req, reply) => {
    if (!deps.store || !deps.workspace) {
      return reply.code(503).send({ error: "folder workspace unavailable" });
    }
    if (!deps.toolApprovals) {
      return reply.code(503).send({ error: "approval gate unavailable" });
    }
    const parsed = WriteWorkspaceFileRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid write_workspace_file request" });
    }
    const folder = await getSessionFolder(deps.store, parsed.data.sessionID);
    if (!folder) return reply.code(404).send({ error: "folder not connected" });
    const approved = await awaitWriteApproval(parsed.data.sessionID, "write_workspace_file", {
      tool: "write_workspace_file",
      path: parsed.data.path,
      content: parsed.data.content,
      summary: `Create or replace workspace file "${parsed.data.path}".`,
    });
    if (!approved) {
      await recordToolCallLineage(parsed.data.sessionID, "write_workspace_file", "rejected", {
        path: parsed.data.path,
      });
      return reply.code(200).send({ approved: false });
    }
    try {
      await deps.workspace.write(folder.path, parsed.data.path, parsed.data.content);
      await indexConnectedFolder(parsed.data.sessionID, folder.path);
      await recordToolCallLineage(parsed.data.sessionID, "write_workspace_file", "completed", {
        path: parsed.data.path,
        bytes: Buffer.byteLength(parsed.data.content),
      });
      return reply.code(200).send({ path: parsed.data.path, bytes: Buffer.byteLength(parsed.data.content) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await recordToolCallLineage(parsed.data.sessionID, "write_workspace_file", "error", {
        path: parsed.data.path,
        error: message,
      });
      return reply.code(422).send({ error: `could not write workspace file: ${message}` });
    }
  });

  // `land_parquet`: land a session's connected source to Parquet under `<landingDir>/<sessionID>/`.
  app.post("/api/internal/tools/land_parquet", async (req, reply) => {
    if (!deps.store) {
      return reply.code(503).send({ error: "session source store unavailable" });
    }
    if (!deps.toolApprovals) {
      return reply.code(503).send({ error: "approval gate unavailable" });
    }
    const parsed = LandParquetRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid land_parquet request", details: parsed.error.issues });
    }

    const source = await getSessionSource(deps.store, parsed.data.sessionID, parsed.data.source);
    if (!source) {
      return reply.code(404).send({ error: "source not found" });
    }

    const approved = await awaitWriteApproval(parsed.data.sessionID, "land_parquet", {
      tool: "land_parquet",
      source: parsed.data.source,
      ...(parsed.data.ingestionDate ? { ingestionDate: parsed.data.ingestionDate } : {}),
      summary: `Land source "${parsed.data.source}" to partitioned Parquet.`,
    });
    if (!approved) {
      await recordToolCallLineage(parsed.data.sessionID, "land_parquet", "rejected", {
        source: parsed.data.source,
      });
      return reply.code(200).send({ approved: false });
    }

    try {
      const result = await landParquet(await executionStore(parsed.data.sessionID), {
        landingDir: join(landingDir, parsed.data.sessionID),
        sourcePath: source.path,
        sourceKind: source.kind,
        dataset: source.name,
        ingestionDate: parsed.data.ingestionDate,
      });
      await recordToolCallLineage(parsed.data.sessionID, "land_parquet", "completed", {
        source: parsed.data.source,
        dataset: result.dataset,
        ingestionDate: result.ingestionDate,
        rowCount: result.rowCount,
      });
      return reply.code(200).send({
        dataset: result.dataset,
        ingestionDate: result.ingestionDate,
        rowCount: result.rowCount,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await recordToolCallLineage(parsed.data.sessionID, "land_parquet", "error", {
        source: parsed.data.source,
        error: message,
      });
      return reply.code(422).send({ error: `could not land source: ${message}` });
    }
  });

  // `load_warehouse`: load a landed dataset into `raw`/`staging`. The landing path is reconstructed
  // server-side from the session + dataset name (same sanitizer the land step used) so no path is
  // trusted from the model.
  app.post("/api/internal/tools/load_warehouse", async (req, reply) => {
    if (!deps.store) {
      return reply.code(503).send({ error: "session source store unavailable" });
    }
    if (!deps.toolApprovals) {
      return reply.code(503).send({ error: "approval gate unavailable" });
    }
    const parsed = LoadWarehouseRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid load_warehouse request", details: parsed.error.issues });
    }

    const targetSchema = parsed.data.schema ?? "raw";
    const targetTable = parsed.data.table ?? "source";
    const approved = await awaitWriteApproval(parsed.data.sessionID, "load_warehouse", {
      tool: "load_warehouse",
      dataset: parsed.data.dataset,
      schema: targetSchema,
      table: targetTable,
      summary: `Load dataset "${parsed.data.dataset}" into ${targetSchema}.${targetTable}.`,
    });
    if (!approved) {
      await recordToolCallLineage(parsed.data.sessionID, "load_warehouse", "rejected", {
        dataset: parsed.data.dataset,
        schema: targetSchema,
        table: targetTable,
      });
      return reply.code(200).send({ approved: false });
    }

    const landingPath = join(
      landingDir,
      parsed.data.sessionID,
      safeDatasetName(parsed.data.dataset),
    );
    try {
      const result = await loadWarehouse(await executionStore(parsed.data.sessionID), {
        landingPath,
        schema: parsed.data.schema as "raw" | "staging" | undefined,
        table: parsed.data.table,
      });
      await recordToolCallLineage(parsed.data.sessionID, "load_warehouse", "completed", {
        dataset: parsed.data.dataset,
        qualifiedTable: result.qualifiedTable,
        rowCount: result.rowCount,
      });
      return reply.code(200).send({
        qualifiedTable: result.qualifiedTable,
        schema: result.schema,
        table: result.table,
        rowCount: result.rowCount,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await recordToolCallLineage(parsed.data.sessionID, "load_warehouse", "error", {
        dataset: parsed.data.dataset,
        error: message,
      });
      return reply.code(422).send({ error: `could not load dataset: ${message}` });
    }
  });

  // `run_transform`: execute the reviewed transform SQL into `marts.<targetTable>`. The SQL runs
  // verbatim — it is the exact text the human approved at the gate.
  app.post("/api/internal/tools/run_transform", async (req, reply) => {
    if (!deps.store) {
      return reply.code(503).send({ error: "session source store unavailable" });
    }
    if (!deps.toolApprovals) {
      return reply.code(503).send({ error: "approval gate unavailable" });
    }
    const parsed = RunTransformRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid run_transform request", details: parsed.error.issues });
    }

    // The metadata carries the EXACT SQL the human reviews before it runs verbatim (FR10).
    const approved = await awaitWriteApproval(parsed.data.sessionID, "run_transform", {
      tool: "run_transform",
      sql: parsed.data.sql,
      targetTable: parsed.data.targetTable,
      summary: `Run transform SQL into marts.${parsed.data.targetTable}.`,
    });
    if (!approved) {
      await recordToolCallLineage(parsed.data.sessionID, "run_transform", "rejected", {
        sql: parsed.data.sql,
        targetTable: parsed.data.targetTable,
      });
      return reply.code(200).send({ approved: false });
    }

    try {
      const result = await runTransform(await executionStore(parsed.data.sessionID), {
        sql: parsed.data.sql,
        targetTable: parsed.data.targetTable,
      });
      await recordToolCallLineage(parsed.data.sessionID, "run_transform", "completed", {
        sql: parsed.data.sql,
        qualifiedTable: result.qualifiedTable,
        rowCount: result.rowCount,
      });
      return reply.code(200).send({
        qualifiedTable: result.qualifiedTable,
        table: result.table,
        rowCount: result.rowCount,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await recordToolCallLineage(parsed.data.sessionID, "run_transform", "error", {
        sql: parsed.data.sql,
        targetTable: parsed.data.targetTable,
        error: message,
      });
      return reply.code(422).send({ error: `could not run transform: ${message}` });
    }
  });

  // `publish_serving`: export a `marts` table to CSV under `<servingDir>/<sessionID>/` and register
  // it in the served-table registry. The session id namespaces the export (the v2 owner of a
  // published table is the session).
  app.post("/api/internal/tools/publish_serving", async (req, reply) => {
    if (!deps.store) {
      return reply.code(503).send({ error: "session source store unavailable" });
    }
    if (!deps.toolApprovals) {
      return reply.code(503).send({ error: "approval gate unavailable" });
    }
    const parsed = PublishServingRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid publish_serving request", details: parsed.error.issues });
    }

    // FR9: a failing DQ run blocks publish. Consult the gate BEFORE opening the approval — there
    // is no point asking a human to approve a publish that must be refused. The refusal names the
    // failed checks so the agent can tell the user what to fix and re-run `run_dq_check`.
    if (deps.dqGate?.isPublishBlocked(parsed.data.sessionID)) {
      const latest = deps.dqGate.latest(parsed.data.sessionID);
      const failedChecks = (latest?.results ?? []).filter((r) => !r.passed).map((r) => r.name);
      return reply.code(409).send({
        error: "publish blocked: the most recent data-quality checks failed",
        blocked: true,
        failedChecks,
      });
    }

    const requestedName = parsed.data.name ?? parsed.data.table;
    // The legacy project workflow keeps its public name. Chat-owned publishes use a session
    // prefix because the shared endpoint registry is keyed by URL name; this prevents two live
    // sessions that both publish `report` from replacing one another.
    const servedName = deps.sessionWarehouses
      ? sessionScopedServedName(parsed.data.sessionID, requestedName)
      : requestedName;
    const approved = await awaitWriteApproval(parsed.data.sessionID, "publish_serving", {
      tool: "publish_serving",
      table: parsed.data.table,
      name: servedName,
      summary: `Publish marts.${parsed.data.table} as endpoint "${servedName}".`,
    });
    // A DQ-blocked publish (409 above) records no tool_call — the `dq_result` row already explains
    // the block. From here on the publish was approved-or-rejected like any other write.
    if (!approved) {
      await recordToolCallLineage(parsed.data.sessionID, "publish_serving", "rejected", {
        table: parsed.data.table,
        name: servedName,
      });
      return reply.code(200).send({ approved: false });
    }

    try {
      const result = await publishServing(await executionStore(parsed.data.sessionID), {
        servingDir,
        projectId: parsed.data.sessionID,
        table: parsed.data.table,
        name: servedName,
      }, deps.store);
      await recordToolCallLineage(parsed.data.sessionID, "publish_serving", "completed", {
        table: parsed.data.table,
        name: result.name,
        endpoint: result.endpoint,
        rowCount: result.rowCount,
      });
      return reply.code(200).send({
        name: result.name,
        endpoint: result.endpoint,
        csvEndpoint: result.csvEndpoint,
        rowCount: result.rowCount,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await recordToolCallLineage(parsed.data.sessionID, "publish_serving", "error", {
        table: parsed.data.table,
        name: servedName,
        error: message,
      });
      return reply.code(422).send({ error: `could not publish table: ${message}` });
    }
  });

  // `attach_source`: attach a registered Postgres connection to the session read-only (V5.2, FR5b).
  // The model sends only the connection NAME; the backend resolves it to the credentialed URL and
  // ATTACHes read-only — the raw URL never reaches the model, the approval pill, or the SSE stream.
  // Ask-gated like the other writes (it connects a live database), so it pauses for approval; the
  // approval metadata carries only the name + type, never the URL. Status map: 503 unwired
  // store/gate/attacher, 400 bad body (incl. an invalid connection name), 404 no connection of that
  // name registered, 422 the attach failed (secret-scrubbed detail), 200 with `{ name, tables }`
  // (or `{ approved: false }` on rejection).
  app.post("/api/internal/tools/attach_source", async (req, reply) => {
    if (!deps.store) {
      return reply.code(503).send({ error: "session source store unavailable" });
    }
    if (!deps.toolApprovals) {
      return reply.code(503).send({ error: "approval gate unavailable" });
    }
    if (!deps.attachSource) {
      return reply.code(503).send({ error: "postgres attach unavailable" });
    }
    const parsed = AttachSourceRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid attach_source request", details: parsed.error.issues });
    }

    // Resolve name → the stored connection BEFORE opening the approval — no point asking a human to
    // approve attaching a connection that was never registered. The secret url stays in this local;
    // it is NEVER put into the approval metadata, the lineage detail, or the response (FR5b).
    const stored = await getStoredConnection(deps.store, parsed.data.name);
    if (!stored) {
      return reply.code(404).send({ error: "connection not found" });
    }

    const approved = await awaitWriteApproval(parsed.data.sessionID, "attach_source", {
      tool: "attach_source",
      connection: parsed.data.name,
      type: stored.type,
      summary: `Attach connection "${parsed.data.name}" (${stored.type}) read-only.`,
    });
    if (!approved) {
      await recordToolCallLineage(parsed.data.sessionID, "attach_source", "rejected", {
        connection: parsed.data.name,
      });
      return reply.code(200).send({ approved: false });
    }

    try {
      const isolated = await executionStore(parsed.data.sessionID);
      const result = await deps.attachSource(isolated, {
        alias: parsed.data.name,
        url: stored.url,
      });
      // Surface each attached table to the agent through `list_sources` (V5.3, FR5b): register it as
      // a `postgres` session source under its qualified `<alias>.<schema>.<table>` name — the exact
      // identifier `run_query` resolves against the persistent ATTACH. The registry stores no URL
      // (the path field carries the qualified name, a non-secret backend resolution target), so the
      // credential still never crosses to the model. Re-attach is idempotent (upsert on name).
      for (const table of result.tables) {
        const name = attachedTableName(parsed.data.name, table.schema, table.table);
        await registerSessionSource(deps.store, {
          sessionId: parsed.data.sessionID,
          name,
          kind: POSTGRES_SOURCE_KIND,
          path: name,
          origin: "connection",
        });
        if (isolated !== deps.store) {
          await registerSessionSource(isolated, {
            sessionId: parsed.data.sessionID,
            name,
            kind: POSTGRES_SOURCE_KIND,
            path: name,
            origin: "connection",
          });
        }
      }
      await recordToolCallLineage(parsed.data.sessionID, "attach_source", "completed", {
        connection: parsed.data.name,
        tableCount: result.tables.length,
      });
      return reply.code(200).send({ name: parsed.data.name, tables: result.tables });
    } catch (err) {
      // The attacher scrubs the secret out of any driver error before throwing, so this message is
      // safe to surface + persist.
      const message = err instanceof Error ? err.message : String(err);
      await recordToolCallLineage(parsed.data.sessionID, "attach_source", "error", {
        connection: parsed.data.name,
        error: message,
      });
      return reply.code(422).send({ error: `could not attach connection: ${message}` });
    }
  });

  return app;
}
