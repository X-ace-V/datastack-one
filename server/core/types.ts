import { z } from "zod";

/**
 * Pure domain types + zod schemas. This module is the trusted contract shared by
 * routes, tools, and the OpenCode bridge. It must stay pure — no fs/net/process
 * imports — so it can be validated and reused anywhere. See ARCHITECTURE §3.2.
 */

/** Response contract for `GET /api/health`. */
export const HealthStatusSchema = z.object({
  /** Literal marker so clients can assert liveness, not just a 200. */
  status: z.literal("ok"),
  /** Service identity — guards against pointing the UI at the wrong backend. */
  service: z.literal("datastack-one"),
  /** Semver of the running backend. */
  version: z.string().min(1),
  /** Process uptime in seconds; non-negative. */
  uptime: z.number().nonnegative(),
});
export type HealthStatus = z.infer<typeof HealthStatusSchema>;
