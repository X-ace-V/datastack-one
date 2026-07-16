import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "./app.js";
import { openStore, type WarehouseStore } from "./store/duckdb.js";
import { ProjectSchema } from "./core/projects.js";

/**
 * Route tests for `POST/GET /api/projects` (T2.1, FR1). They drive the real Fastify
 * app via `app.inject` against a real in-memory store — no mocks — so the full path
 * (validation → parameterized persist → read-back) is exercised end to end, and assert
 * the desired HTTP contract: 201 with a schema-valid project, 200 list, 400 on bad
 * input, 503 when the store is unwired.
 */
describe("project routes", () => {
  const open: WarehouseStore[] = [];

  afterEach(async () => {
    await Promise.all(open.splice(0).map((s) => s.close()));
  });

  async function appWithStore() {
    const store = await openStore(":memory:");
    open.push(store);
    return buildServer({ store });
  }

  it("creates a project and returns 201 with the persisted row", async () => {
    const app = await appWithStore();
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Loan Book", domain: "lending", servingStyle: "rest" },
    });

    expect(res.statusCode).toBe(201);
    const project = ProjectSchema.parse(res.json());
    expect(project.name).toBe("Loan Book");
    expect(project.domain).toBe("lending");
    expect(project.servingStyle).toBe("rest");
    // Default applied even though the client did not send it.
    expect(project.warehouse).toBe("duckdb");
    expect(project.id).toBeTruthy();
  });

  it("lists created projects, newest first", async () => {
    const app = await appWithStore();
    await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "First", domain: "lending" },
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Second", domain: "lending" },
    });
    const secondId = ProjectSchema.parse(second.json()).id;

    const res = await app.inject({ method: "GET", url: "/api/projects" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { projects: unknown[] };
    const projects = body.projects.map((p) => ProjectSchema.parse(p));
    expect(projects.map((p) => p.name)).toEqual(["Second", "First"]);
    // The most recent create is first in the list.
    expect(projects[0]?.id).toBe(secondId);
  });

  it("rejects a project with a missing name with 400", async () => {
    const app = await appWithStore();
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { domain: "lending" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toHaveProperty("error");
  });

  it("rejects an unsupported warehouse with 400", async () => {
    const app = await appWithStore();
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "X", domain: "lending", warehouse: "snowflake" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("reports 503 for POST when the store is unwired", async () => {
    const app = buildServer({});
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "X", domain: "lending" },
    });
    expect(res.statusCode).toBe(503);
  });

  it("reports 503 for GET when the store is unwired", async () => {
    const app = buildServer({});
    const res = await app.inject({ method: "GET", url: "/api/projects" });
    expect(res.statusCode).toBe(503);
  });
});
