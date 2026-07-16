import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "./app.js";
import { openStore, type WarehouseStore } from "./store/duckdb.js";
import { insertProject } from "./store/projects.js";
import { insertArtifact } from "./store/artifacts.js";
import { ReviewArtifactsResponseSchema, type ArtifactKind } from "./core/artifacts.js";

/**
 * Route tests for `GET /api/projects/:id/artifacts` (T3.5, FR3/FR6/FR7). The Review step reads
 * the newest artifact of each generated kind — plan, transform SQL, DDL, DQ spec — so a human
 * can inspect everything before approving execution. These assert the desired values (the right
 * artifact per kind, newest-wins, nulls when a stage has not run) over a real in-memory
 * warehouse, plus the 404/503 boundaries.
 */
describe("review artifacts route", () => {
  const open: WarehouseStore[] = [];

  afterEach(async () => {
    await Promise.all(open.splice(0).map((s) => s.close()));
  });

  async function fixtures() {
    const store = await openStore(":memory:");
    open.push(store);
    const project = await insertProject(store, {
      name: "Loan Book",
      domain: "lending",
      warehouse: "duckdb",
    });
    const app = buildServer({ store });
    return { app, store, projectId: project.id };
  }

  async function addArtifact(
    store: WarehouseStore,
    projectId: string,
    kind: ArtifactKind,
    content: string,
  ) {
    return insertArtifact(store, { id: randomUUID(), projectId, kind, content });
  }

  it("returns the newest plan, transform, DDL and DQ artifacts for review", async () => {
    const { app, store, projectId } = await fixtures();
    const plan = await addArtifact(store, projectId, "plan", JSON.stringify({ pattern: "ELT" }));
    const transform = await addArtifact(
      store,
      projectId,
      "transform_sql",
      JSON.stringify({ sql: "SELECT 1" }),
    );
    const ddl = await addArtifact(store, projectId, "ddl", "CREATE TABLE marts.x (id INT);");
    const dq = await addArtifact(store, projectId, "dq_spec", JSON.stringify({ checks: [] }));

    const res = await app.inject({ method: "GET", url: `/api/projects/${projectId}/artifacts` });
    expect(res.statusCode).toBe(200);

    const body = ReviewArtifactsResponseSchema.parse(res.json());
    expect(body.plan?.id).toBe(plan.id);
    expect(body.plan?.content).toBe('{"pattern":"ELT"}');
    expect(body.transform?.id).toBe(transform.id);
    expect(body.transform?.content).toBe('{"sql":"SELECT 1"}');
    expect(body.ddl?.id).toBe(ddl.id);
    expect(body.ddl?.content).toBe("CREATE TABLE marts.x (id INT);");
    expect(body.dq?.id).toBe(dq.id);
    expect(body.dq?.content).toBe('{"checks":[]}');
  });

  it("returns null for a kind that has not been generated yet", async () => {
    const { app, store, projectId } = await fixtures();
    // Only a plan exists — transform, DDL and DQ are still outstanding.
    await addArtifact(store, projectId, "plan", JSON.stringify({ pattern: "ELT" }));

    const res = await app.inject({ method: "GET", url: `/api/projects/${projectId}/artifacts` });
    const body = ReviewArtifactsResponseSchema.parse(res.json());
    expect(body.plan).not.toBeNull();
    expect(body.transform).toBeNull();
    expect(body.ddl).toBeNull();
    expect(body.dq).toBeNull();
  });

  it("returns all nulls when nothing has been generated", async () => {
    const { app, projectId } = await fixtures();
    const res = await app.inject({ method: "GET", url: `/api/projects/${projectId}/artifacts` });
    expect(res.statusCode).toBe(200);
    const body = ReviewArtifactsResponseSchema.parse(res.json());
    expect(body).toEqual({ plan: null, transform: null, ddl: null, dq: null });
  });

  it("returns the newest artifact when several of a kind exist", async () => {
    const { app, store, projectId } = await fixtures();
    await addArtifact(store, projectId, "plan", JSON.stringify({ version: 1 }));
    const newer = await addArtifact(store, projectId, "plan", JSON.stringify({ version: 2 }));

    const res = await app.inject({ method: "GET", url: `/api/projects/${projectId}/artifacts` });
    const body = ReviewArtifactsResponseSchema.parse(res.json());
    expect(body.plan?.id).toBe(newer.id);
    expect(body.plan?.content).toBe('{"version":2}');
  });

  it("does not leak another project's artifacts", async () => {
    const { app, store, projectId } = await fixtures();
    const other = await insertProject(store, {
      name: "Other",
      domain: "lending",
      warehouse: "duckdb",
    });
    await addArtifact(store, other.id, "plan", JSON.stringify({ pattern: "ELT" }));

    const res = await app.inject({ method: "GET", url: `/api/projects/${projectId}/artifacts` });
    const body = ReviewArtifactsResponseSchema.parse(res.json());
    expect(body.plan).toBeNull();
  });

  it("returns 404 for an unknown project", async () => {
    const { app } = await fixtures();
    const res = await app.inject({ method: "GET", url: "/api/projects/does-not-exist/artifacts" });
    expect(res.statusCode).toBe(404);
  });

  it("reports 503 when the store is unwired", async () => {
    const app = buildServer({});
    const res = await app.inject({ method: "GET", url: "/api/projects/p/artifacts" });
    expect(res.statusCode).toBe(503);
  });
});
