import { describe, expect, it } from "vitest";
import { testConnection, testPostgresConnection } from "./postgres.js";

/**
 * Tests for the REAL DuckDB Postgres connection prober (V5.1, FR5). The negative path is
 * deterministic and offline — an unreachable URL yields `ok:false` with the credential scrubbed
 * from the driver message — which exercises the actual `ATTACH … READ_ONLY` probe + the redaction
 * end to end. The positive path needs a live Postgres, so it reads `TEST_PG_URL` and SKIPS cleanly
 * when unset (V5.4 documents the Neon wiring).
 */
describe("testPostgresConnection (real DuckDB probe)", () => {
  it("reports ok:false for an unreachable host and scrubs the secret", async () => {
    // Port 1 with no listener → a real 'connection refused' from the postgres driver, whose error
    // text echoes the full URL (password included) — the prober must strip it before returning.
    const url = "postgresql://alice:hunter2@127.0.0.1:1/none?sslmode=require";
    const result = await testPostgresConnection(url);

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    // The credential must NOT survive into the returned message.
    expect(result.error).not.toContain("hunter2");
    expect(result.error).not.toContain(url);
  }, 30_000);

  it("dispatches by type through testConnection", async () => {
    const result = await testConnection(
      "postgresql://u:p@127.0.0.1:1/none",
      "postgres",
    );
    expect(result.ok).toBe(false);
  }, 30_000);

  const liveUrl = process.env.TEST_PG_URL;
  it.runIf(liveUrl)(
    "reports ok:true against a live Postgres (TEST_PG_URL)",
    async () => {
      const result = await testPostgresConnection(liveUrl!);
      expect(result).toEqual({ ok: true, error: null });
    },
    30_000,
  );
});
