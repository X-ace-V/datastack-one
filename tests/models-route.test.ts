import { describe, it, expect, afterAll } from "vitest";
import { buildServer } from "../server/app.js";
import type { ModelsClient } from "../server/opencode/models.js";
import { ModelsResponseSchema } from "../server/core/types.js";

/**
 * Route-level tests for `GET /api/models` (T1.2 / FR11). These exercise the actual
 * Fastify wiring via `app.inject` — that a mocked OpenCode client flows through the
 * route to a schema-valid catalog, and that an unwired runtime reports 503 honestly
 * rather than pretending an empty catalog is the truth. The normalization logic itself
 * is covered by server/opencode/models.test.ts.
 */

/** A providers payload shaped like the real `config.providers()` response. */
const PROVIDERS_FIXTURE = {
  data: {
    default: { opencode: "big-pickle" },
    providers: [
      {
        id: "opencode",
        name: "OpenCode Zen",
        source: "api",
        env: [],
        options: {},
        models: {
          "big-pickle": {
            id: "big-pickle",
            name: "Big Pickle",
            capabilities: { toolcall: true, reasoning: false },
            cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          },
        },
      },
    ],
  },
  error: undefined,
};

/** Build a `ModelsClient` whose `config.providers()` resolves to the fixture. */
function mockClient(): ModelsClient {
  return {
    config: { providers: async () => PROVIDERS_FIXTURE },
  } as unknown as ModelsClient;
}

describe("GET /api/models", () => {
  const withRuntime = buildServer({ opencode: mockClient() });
  const noRuntime = buildServer();

  afterAll(async () => {
    await withRuntime.close();
    await noRuntime.close();
  });

  it("returns 200 with a schema-valid catalog when the runtime is wired", async () => {
    const res = await withRuntime.inject({ method: "GET", url: "/api/models" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(() => ModelsResponseSchema.parse(body)).not.toThrow();
    expect(body.default).toBe("opencode/big-pickle");
    expect(body.providers).toHaveLength(1);
    expect(body.providers[0].models[0].ref).toBe("opencode/big-pickle");
    expect(body.providers[0].models[0].free).toBe(true);
  });

  it("returns 503 when the model runtime is not wired", async () => {
    const res = await noRuntime.inject({ method: "GET", url: "/api/models" });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "model runtime unavailable" });
  });
});
