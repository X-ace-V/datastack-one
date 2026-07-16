import Fastify, { type FastifyInstance } from "fastify";
import { HealthStatusSchema, type HealthStatus } from "./core/types.js";

/** Backend identity, surfaced by `/api/health` so a client can confirm the target. */
export const SERVICE_NAME = "datastack-one";
export const SERVICE_VERSION = "0.0.0";

/**
 * Build the Fastify instance with all routes registered but not yet listening.
 * Kept separate from {@link file://./index.ts} boot so tests can drive it via
 * `app.inject(...)` without binding a port.
 */
export function buildServer(): FastifyInstance {
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

  return app;
}
