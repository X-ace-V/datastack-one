import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "./app.js";
import { openStore, type WarehouseStore } from "./store/duckdb.js";
import { insertProject } from "./store/projects.js";
import { publishServing } from "./tools/serve.js";
import { SERVED_PAGE_DEFAULT_LIMIT, SERVED_PAGE_MAX_LIMIT } from "./core/serving.js";
import type { ServedTable } from "./core/serving.js";
import type { FastifyInstance } from "fastify";

/**
 * Route tests for the generated serving endpoints (T5.3 / PRD FR10) — `GET /api/serve/:name` and
 * `GET /api/serve/:name.csv`, the "queryable (REST) and downloadable (CSV)" acceptance criterion.
 * They run over a real in-memory warehouse whose table is published by the real `publish_serving`
 * tool, so what the routes resolve is a genuinely published table, and assert the served values
 * plus the full status map.
 */
describe("serving routes", () => {
  const open: WarehouseStore[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(open.splice(0).map((s) => s.close()));
    await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  /** A server whose warehouse has `branch_balance_totals` published, as a real run would leave it. */
  async function fixtures(): Promise<{
    app: FastifyInstance;
    store: WarehouseStore;
    served: ServedTable;
  }> {
    const store = await openStore(":memory:");
    open.push(store);
    const dir = await mkdtemp(join(tmpdir(), "datastack-serve-route-"));
    tempDirs.push(dir);
    await store.run(
      `CREATE OR REPLACE TABLE marts.branch_balance_totals AS
         SELECT * FROM (VALUES ('north', 1750.75), ('south', 0.0)) AS t(branch, total_balance)`,
    );
    const served = await publishServing(store, {
      servingDir: join(dir, "serving"),
      projectId: "p1",
      runId: "r1",
      table: "branch_balance_totals",
    });
    return { app: buildServer({ store }), store, served };
  }

  it("serves the published table as JSON at its generated endpoint", async () => {
    const { app, served } = await fixtures();

    const res = await app.inject({ method: "GET", url: "/api/serve/branch_balance_totals" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      name: "branch_balance_totals",
      schema: "marts",
      table: "branch_balance_totals",
      qualifiedTable: "marts.branch_balance_totals",
      format: "csv",
      endpoint: "/api/serve/branch_balance_totals",
      csvEndpoint: "/api/serve/branch_balance_totals.csv",
      rowCount: 2,
      limit: SERVED_PAGE_DEFAULT_LIMIT,
      offset: 0,
      columns: [
        { name: "branch", type: "VARCHAR" },
        { name: "total_balance", type: "DOUBLE" },
      ],
    });
    // Row order is not a contract (the transform has no ORDER BY) — assert the rows themselves.
    expect(body.rows).toHaveLength(2);
    expect(body.rows).toContainEqual({ branch: "north", total_balance: 1750.75 });
    expect(body.rows).toContainEqual({ branch: "south", total_balance: 0 });
    // The endpoint the registry advertises is the one that answered.
    expect(served.endpoint).toBe("/api/serve/branch_balance_totals");
  });

  it("downloads the published table as a CSV attachment", async () => {
    const { app } = await fixtures();

    const res = await app.inject({ method: "GET", url: "/api/serve/branch_balance_totals.csv" });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/csv; charset=utf-8");
    expect(res.headers["content-disposition"]).toBe(
      'attachment; filename="branch_balance_totals.csv"',
    );
    expect(Number(res.headers["content-length"])).toBe(Buffer.byteLength(res.body));
    // The CSV carries a header plus every served row.
    const lines = res.body.split("\n").filter(Boolean);
    expect(lines[0]).toBe("branch,total_balance");
    expect(lines).toHaveLength(3);
    expect(lines).toContain("north,1750.75");
  });

  it("routes the .csv suffix separately from the name, never as part of it", async () => {
    const { app } = await fixtures();

    const json = await app.inject({ method: "GET", url: "/api/serve/branch_balance_totals" });
    const csv = await app.inject({ method: "GET", url: "/api/serve/branch_balance_totals.csv" });

    // Same name, two representations — the suffix must not be swallowed into `:name`.
    expect(json.headers["content-type"]).toContain("application/json");
    expect(csv.headers["content-type"]).toBe("text/csv; charset=utf-8");
    expect(json.json().name).toBe("branch_balance_totals");
  });

  it("pages the served rows on request", async () => {
    const { app } = await fixtures();

    const res = await app.inject({
      method: "GET",
      url: "/api/serve/branch_balance_totals?limit=1&offset=1",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.limit).toBe(1);
    expect(body.offset).toBe(1);
    expect(body.rows).toHaveLength(1);
    // The total stays the table's, not the page's.
    expect(body.rowCount).toBe(2);
  });

  it("rejects an unusable page instead of quietly clamping it", async () => {
    const { app } = await fixtures();

    for (const query of ["limit=abc", "limit=0", "limit=-1", "offset=-1", `limit=${SERVED_PAGE_MAX_LIMIT + 1}`]) {
      const res = await app.inject({
        method: "GET",
        url: `/api/serve/branch_balance_totals?${query}`,
      });
      expect(res.statusCode, query).toBe(400);
      expect(res.json().error).toBe("invalid serve query");
    }
  });

  it("reports 404 for a name nothing is served at, on both endpoints", async () => {
    const { app } = await fixtures();

    const json = await app.inject({ method: "GET", url: "/api/serve/not_published" });
    const csv = await app.inject({ method: "GET", url: "/api/serve/not_published.csv" });

    expect(json.statusCode).toBe(404);
    expect(csv.statusCode).toBe(404);
    expect(json.json().error).toContain("not_published");
  });

  it("looks the name up as requested, so a different spelling misses rather than resolving", async () => {
    const { app } = await fixtures();

    // The registry only holds sanitized names; an unsanitized request must not be rewritten
    // into a hit, or two URLs would answer for one resource.
    const res = await app.inject({ method: "GET", url: "/api/serve/branch balance totals" });

    expect(res.statusCode).toBe(404);
  });

  it("reports 410 when a registered name's export is gone, on both endpoints", async () => {
    const { app, served } = await fixtures();
    await rm(served.csvPath);

    const json = await app.inject({ method: "GET", url: "/api/serve/branch_balance_totals" });
    const csv = await app.inject({ method: "GET", url: "/api/serve/branch_balance_totals.csv" });

    // The name is still registered, so this is not a 404 — the published export is gone.
    expect(json.statusCode).toBe(410);
    expect(csv.statusCode).toBe(410);
    expect(json.json().error).toContain(served.csvPath);
    expect(json.json().error).toContain("publish");
  });

  it("reports 503 on both endpoints when the store is unwired", async () => {
    const app = buildServer();

    const json = await app.inject({ method: "GET", url: "/api/serve/anything" });
    const csv = await app.inject({ method: "GET", url: "/api/serve/anything.csv" });

    expect(json.statusCode).toBe(503);
    expect(csv.statusCode).toBe(503);
    expect(json.json().error).toBe("served table store unavailable");
  });
});

/**
 * Route tests for `GET /api/projects/:id/served` (T5.4 / FR10) — the join the Serve page needs
 * between the project the wizard carries and the served *name* the registry is keyed by. The
 * tables are published by the real `publish_serving` tool against a real project row, so the list
 * describes genuinely published endpoints.
 */
describe("project served-tables route", () => {
  const open: WarehouseStore[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(open.splice(0).map((s) => s.close()));
    await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function fixtures(): Promise<{
    app: FastifyInstance;
    store: WarehouseStore;
    projectId: string;
    servingDir: string;
  }> {
    const store = await openStore(":memory:");
    open.push(store);
    const dir = await mkdtemp(join(tmpdir(), "datastack-served-list-"));
    tempDirs.push(dir);
    const project = await insertProject(store, {
      name: "Loan Book",
      domain: "lending",
      warehouse: "duckdb",
    });
    return {
      app: buildServer({ store }),
      store,
      projectId: project.id,
      servingDir: join(dir, "serving"),
    };
  }

  it("lists the endpoints a project has published", async () => {
    const { app, store, projectId, servingDir } = await fixtures();
    await store.run(
      `CREATE OR REPLACE TABLE marts.branch_balance_totals AS
         SELECT * FROM (VALUES ('north', 1750.75), ('south', 0.0)) AS t(branch, total_balance)`,
    );
    await publishServing(store, {
      servingDir,
      projectId,
      runId: "r1",
      table: "branch_balance_totals",
    });

    const res = await app.inject({ method: "GET", url: `/api/projects/${projectId}/served` });

    expect(res.statusCode).toBe(200);
    const { served } = res.json() as { served: ServedTable[] };
    expect(served).toHaveLength(1);
    expect(served[0]).toMatchObject({
      name: "branch_balance_totals",
      projectId,
      runId: "r1",
      schema: "marts",
      table: "branch_balance_totals",
      qualifiedTable: "marts.branch_balance_totals",
      format: "csv",
      rowCount: 2,
      // The URLs the page renders come straight off the row — no second lookup needed.
      endpoint: "/api/serve/branch_balance_totals",
      csvEndpoint: "/api/serve/branch_balance_totals.csv",
    });
  });

  it("returns an empty list for a project that has not published yet", async () => {
    const { app, projectId } = await fixtures();

    const res = await app.inject({ method: "GET", url: `/api/projects/${projectId}/served` });

    // Never having published is a normal pre-run state, not an error.
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ served: [] });
  });

  it("does not list another project's published endpoints", async () => {
    const { app, store, projectId, servingDir } = await fixtures();
    const other = await insertProject(store, {
      name: "Other Book",
      domain: "lending",
      warehouse: "duckdb",
    });
    await store.run(
      `CREATE OR REPLACE TABLE marts.other_totals AS
         SELECT * FROM (VALUES ('east', 10.0)) AS t(branch, total_balance)`,
    );
    await publishServing(store, {
      servingDir,
      projectId: other.id,
      runId: null,
      table: "other_totals",
    });

    const res = await app.inject({ method: "GET", url: `/api/projects/${projectId}/served` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ served: [] });
    const otherRes = await app.inject({ method: "GET", url: `/api/projects/${other.id}/served` });
    expect((otherRes.json() as { served: ServedTable[] }).served.map((t) => t.name)).toEqual([
      "other_totals",
    ]);
  });

  it("reports 404 for an unknown project", async () => {
    const { app } = await fixtures();

    const res = await app.inject({ method: "GET", url: "/api/projects/nope/served" });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("project not found");
  });

  it("reports 503 when the store is unwired", async () => {
    const res = await buildServer().inject({ method: "GET", url: "/api/projects/p1/served" });

    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("served table store unavailable");
  });
});
