import { describe, it, expect, afterAll } from "vitest";
import { buildServer } from "../server/app.js";
import { HealthStatusSchema } from "../server/core/types.js";

const app = buildServer();

afterAll(async () => {
  await app.close();
});

describe("GET /api/health", () => {
  it("returns 200 with a schema-valid health payload", async () => {
    const res = await app.inject({ method: "GET", url: "/api/health" });

    expect(res.statusCode).toBe(200);

    const body = res.json();
    // Assert the desired values, not merely that a response came back.
    expect(() => HealthStatusSchema.parse(body)).not.toThrow();
    expect(body.status).toBe("ok");
    expect(body.service).toBe("datastack-one");
    expect(typeof body.version).toBe("string");
    expect(body.version.length).toBeGreaterThan(0);
    expect(body.uptime).toBeGreaterThanOrEqual(0);
  });

  it("404s an unknown route", async () => {
    const res = await app.inject({ method: "GET", url: "/api/nope" });
    expect(res.statusCode).toBe(404);
  });
});
