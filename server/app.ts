import Fastify, { type FastifyInstance } from "fastify";
import { HealthStatusSchema, type HealthStatus } from "./core/types.js";
import { ApprovalDecisionSchema } from "./core/approvals.js";
import { listModels, type ModelsClient } from "./opencode/models.js";
import type { RunBridge } from "./opencode/bridge.js";
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
}

/**
 * Build the Fastify instance with all routes registered but not yet listening.
 * Kept separate from {@link file://./index.ts} boot so tests can drive it via
 * `app.inject(...)` without binding a port.
 */
export function buildServer(deps: ServerDeps = {}): FastifyInstance {
  const app = Fastify({ logger: false });

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
