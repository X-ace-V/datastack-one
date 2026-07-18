import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "./app.js";
import { openStore, type WarehouseStore } from "./store/duckdb.js";
import { getStoredConnection } from "./store/connections.js";
import { ConnectionSchema, type ConnectionTestResult } from "./core/connections.js";
import type { ConnectionTester } from "./connections/postgres.js";

/**
 * Route tests for the connections API (V5.1, FR5). Drive the real Fastify app via `app.inject`
 * against a real in-memory store, with the connection tester injected as a deterministic stub so
 * the routes are exercised offline. The security-critical assertions: no `/api/connections`
 * response ever carries the `url` secret, and the stored secret DOES land in the warehouse.
 */
describe("connection routes", () => {
  const open: WarehouseStore[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((s) => s.close()));
  });

  const URL = "postgresql://alice:supersecret@db.neon.tech/main?sslmode=require";

  /** Build the app with a real store and a stub tester that records what url it was handed. */
  async function fixtures(result: ConnectionTestResult = { ok: true, error: null }) {
    const store = await openStore(":memory:");
    open.push(store);
    const testedUrls: string[] = [];
    const testConnection: ConnectionTester = async (url) => {
      testedUrls.push(url);
      return result;
    };
    return { app: buildServer({ store, testConnection }), store, testedUrls };
  }

  it("registers a connection, returns 201 with NO url, and stores the secret", async () => {
    const { app, store } = await fixtures();
    const res = await app.inject({
      method: "POST",
      url: "/api/connections",
      payload: { name: "neon_lending", url: URL },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json() as { connection: unknown };
    const connection = ConnectionSchema.parse(body.connection);
    expect(connection).toEqual({
      name: "neon_lending",
      type: "postgres",
      createdAt: expect.any(String),
    });
    // The secret is NOT anywhere in the response payload...
    expect(res.body).not.toContain("supersecret");
    expect(res.body).not.toContain(URL);
    // ...but IS persisted in the gitignored warehouse for the backend to resolve.
    expect((await getStoredConnection(store, "neon_lending"))?.url).toBe(URL);
  });

  it("rejects a bad name or non-postgres url with 400", async () => {
    const { app } = await fixtures();
    const badName = await app.inject({
      method: "POST",
      url: "/api/connections",
      payload: { name: "my-db", url: URL },
    });
    expect(badName.statusCode).toBe(400);

    const badUrl = await app.inject({
      method: "POST",
      url: "/api/connections",
      payload: { name: "db", url: "mysql://u:p@h/db" },
    });
    expect(badUrl.statusCode).toBe(400);
  });

  it("lists connections without any secret", async () => {
    const { app } = await fixtures();
    await app.inject({ method: "POST", url: "/api/connections", payload: { name: "a", url: URL } });
    await app.inject({
      method: "POST",
      url: "/api/connections",
      payload: { name: "b", url: "postgres://u:pw@h/db2" },
    });

    const res = await app.inject({ method: "GET", url: "/api/connections" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { connections: unknown[] };
    const connections = body.connections.map((c) => ConnectionSchema.parse(c));
    expect(connections.map((c) => c.name).sort()).toEqual(["a", "b"]);
    // Not a single secret survives into the list response.
    expect(res.body).not.toContain("supersecret");
    expect(res.body).not.toContain("pw@");
  });

  it("deletes a connection (204) and 404s an unknown one", async () => {
    const { app } = await fixtures();
    await app.inject({ method: "POST", url: "/api/connections", payload: { name: "a", url: URL } });

    const del = await app.inject({ method: "DELETE", url: "/api/connections/a" });
    expect(del.statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/api/connections" })).json()).toEqual({
      connections: [],
    });

    const missing = await app.inject({ method: "DELETE", url: "/api/connections/a" });
    expect(missing.statusCode).toBe(404);
  });

  it("tests a connection: resolves name → the secret url and returns only {ok,error}", async () => {
    const { app, testedUrls } = await fixtures({ ok: true, error: null });
    await app.inject({
      method: "POST",
      url: "/api/connections",
      payload: { name: "neon", url: URL },
    });

    const res = await app.inject({ method: "POST", url: "/api/connections/neon/test" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ result: { ok: true, error: null } });
    // The tester received the resolved secret URL (backend-side) ...
    expect(testedUrls).toEqual([URL]);
    // ... but the URL never appears in the client-facing response.
    expect(res.body).not.toContain(URL);
  });

  it("surfaces a failed probe as ok:false with a (scrubbed) error", async () => {
    const { app } = await fixtures({ ok: false, error: "connection refused" });
    await app.inject({
      method: "POST",
      url: "/api/connections",
      payload: { name: "neon", url: URL },
    });
    const res = await app.inject({ method: "POST", url: "/api/connections/neon/test" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ result: { ok: false, error: "connection refused" } });
  });

  it("404s testing an unknown connection", async () => {
    const { app } = await fixtures();
    const res = await app.inject({ method: "POST", url: "/api/connections/nope/test" });
    expect(res.statusCode).toBe(404);
  });

  it("503s every connection route when the store is unwired", async () => {
    const app = buildServer({});
    for (const [method, url] of [
      ["POST", "/api/connections"],
      ["GET", "/api/connections"],
      ["DELETE", "/api/connections/a"],
      ["POST", "/api/connections/a/test"],
    ] as const) {
      const res = await app.inject({ method, url, payload: { name: "a", url: URL } });
      expect(res.statusCode).toBe(503);
    }
  });

  it("503s the test route when the store is wired but no tester is", async () => {
    const store = await openStore(":memory:");
    open.push(store);
    const app = buildServer({ store });
    await app.inject({ method: "POST", url: "/api/connections", payload: { name: "a", url: URL } });
    const res = await app.inject({ method: "POST", url: "/api/connections/a/test" });
    expect(res.statusCode).toBe(503);
  });
});
