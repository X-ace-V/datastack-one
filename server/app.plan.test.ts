import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "./app.js";
import { openStore, type WarehouseStore } from "./store/duckdb.js";
import { insertProject } from "./store/projects.js";
import { insertSource } from "./store/sources.js";
import { getLatestArtifactByKind } from "./store/artifacts.js";
import { PlanSchema } from "./core/plan.js";
import type { PlanClient } from "./pipeline/plan.js";

/**
 * Route tests for `POST /api/projects/:id/plan` (T3.2, FR3). They exercise the full route +
 * persist path against a real in-memory warehouse and a real CSV on disk; only the external
 * model call is mocked (a canned plan JSON), the honest boundary for a non-deterministic LLM.
 * They assert the desired result — a validated plan returned and persisted as a `plan`
 * artifact — plus every status the route maps: 400/404/422/502/503.
 */
describe("plan route", () => {
  const open: WarehouseStore[] = [];
  const tmpDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(open.splice(0).map((s) => s.close()));
    await Promise.all(
      tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
    );
  });

  const LOANS_CSV =
    "loan_id,branch,balance,opened_at\n" +
    "1,north,1000.50,2024-01-01\n" +
    "2,south,,2024-01-02\n" +
    "3,north,750.25,2024-02-15\n";

  const PLAN = {
    executionPattern: "ELT",
    warehouse: "duckdb",
    partitioning: "Partition landed Parquet by ingestion date.",
    steps: [
      { name: "Extract", description: "Read CSV." },
      { name: "Land Parquet", description: "Write Parquet partitioned by date." },
      { name: "Load Warehouse", description: "Load into raw." },
      { name: "Transform", description: "Apply rules to marts." },
      { name: "DQ Checks", description: "Run checks." },
      { name: "Publish", description: "Serve the table." },
    ],
    summary: "ELT into DuckDB.",
  };

  /** A mock planner whose prompt returns `text` (defaults to a valid plan JSON). */
  function mockPlanner(text: string = JSON.stringify(PLAN), opts: { promptError?: unknown } = {}) {
    const prompt = vi.fn(async () =>
      opts.promptError
        ? { data: undefined, error: opts.promptError }
        : {
            data: {
              info: {},
              parts: [
                { id: "p-0", sessionID: "s", messageID: "m", type: "text" as const, text },
              ],
            },
            error: undefined,
          },
    );
    const create = vi.fn(async () => ({ data: { id: "sess-1" }, error: undefined }));
    return { session: { create, prompt } } as unknown as PlanClient;
  }

  async function csvFile(contents: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "plan-route-"));
    tmpDirs.push(dir);
    const path = join(dir, "loans.csv");
    await writeFile(path, contents);
    return path;
  }

  async function fixtures(planner: PlanClient = mockPlanner()) {
    const store = await openStore(":memory:");
    open.push(store);
    const artifactsDir = await mkdtemp(join(tmpdir(), "plan-artifacts-"));
    tmpDirs.push(artifactsDir);
    const project = await insertProject(store, {
      name: "Loan Book",
      domain: "lending",
      warehouse: "duckdb",
    });
    const app = buildServer({ store, planner, artifactsDir });
    return { app, store, projectId: project.id, artifactsDir };
  }

  it("generates a plan from the newest source and persists a plan artifact", async () => {
    const { app, store, projectId } = await fixtures();
    const path = await csvFile(LOANS_CSV);
    await insertSource(store, { id: "s-1", projectId, path, originalFilename: "loans.csv" });

    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/plan`,
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { plan: unknown; artifact: { kind: string; content: string } };

    // The returned plan validates against the FR3 contract and names its required fields.
    const plan = PlanSchema.parse(body.plan);
    expect(plan.executionPattern).toBe("ELT");
    expect(plan.warehouse).toBe("duckdb");
    expect(plan.steps.length).toBeGreaterThanOrEqual(5);

    // A `plan` artifact was persisted, and its stored content parses back into the same plan.
    expect(body.artifact.kind).toBe("plan");
    const stored = await getLatestArtifactByKind(store, projectId, "plan");
    expect(stored).not.toBeNull();
    expect(PlanSchema.parse(JSON.parse(stored!.content!))).toMatchObject({
      executionPattern: "ELT",
      warehouse: "duckdb",
    });
    // The artifact was written to disk too.
    const onDisk = await readFile(stored!.path!, "utf8");
    expect(PlanSchema.parse(JSON.parse(onDisk)).steps).toHaveLength(6);
  });

  it("plans a named source when sourceId is given", async () => {
    const { app, store, projectId } = await fixtures();
    const path = await csvFile(LOANS_CSV);
    await insertSource(store, { id: "s-target", projectId, path, originalFilename: "loans.csv" });

    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/plan`,
      payload: { sourceId: "s-target" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("400s when the project has no source to plan from", async () => {
    const { app, projectId } = await fixtures();
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/plan`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("404s an unknown project", async () => {
    const { app } = await fixtures();
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/nope/plan",
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });

  it("404s a sourceId that belongs to another project", async () => {
    const { app, store, projectId } = await fixtures();
    const other = await insertProject(store, {
      name: "Other",
      domain: "lending",
      warehouse: "duckdb",
    });
    const path = await csvFile(LOANS_CSV);
    await insertSource(store, {
      id: "s-other",
      projectId: other.id,
      path,
      originalFilename: "loans.csv",
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/plan`,
      payload: { sourceId: "s-other" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("422s when the source CSV cannot be read", async () => {
    const { app, store, projectId } = await fixtures();
    await insertSource(store, {
      id: "s-missing",
      projectId,
      path: join(tmpdir(), "definitely-not-here-plan.csv"),
      originalFilename: "gone.csv",
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/plan`,
      payload: {},
    });
    expect(res.statusCode).toBe(422);
  });

  it("422s when the model output is not a valid plan", async () => {
    const { app, store, projectId } = await fixtures(mockPlanner("I cannot produce a plan."));
    const path = await csvFile(LOANS_CSV);
    await insertSource(store, { id: "s-1", projectId, path, originalFilename: "loans.csv" });

    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/plan`,
      payload: {},
    });
    expect(res.statusCode).toBe(422);
    // A bad model output must not leave a persisted plan artifact behind.
    expect(await getLatestArtifactByKind(store, projectId, "plan")).toBeNull();
  });

  it("502s when the agent runtime fails the prompt", async () => {
    const planner = mockPlanner("", { promptError: { message: "model unavailable" } });
    const { app, store, projectId } = await fixtures(planner);
    const path = await csvFile(LOANS_CSV);
    await insertSource(store, { id: "s-1", projectId, path, originalFilename: "loans.csv" });

    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/plan`,
      payload: {},
    });
    expect(res.statusCode).toBe(502);
  });

  it("400s an invalid body type", async () => {
    const { app, projectId } = await fixtures();
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/plan`,
      payload: { model: 123 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("503s when the store is unwired", async () => {
    const app = buildServer({ planner: mockPlanner() });
    const res = await app.inject({ method: "POST", url: "/api/projects/p/plan", payload: {} });
    expect(res.statusCode).toBe(503);
  });

  it("503s when the planner is unwired", async () => {
    const store = await openStore(":memory:");
    open.push(store);
    const app = buildServer({ store });
    const res = await app.inject({ method: "POST", url: "/api/projects/p/plan", payload: {} });
    expect(res.statusCode).toBe(503);
  });
});
