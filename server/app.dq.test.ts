import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "./app.js";
import { openStore, type WarehouseStore } from "./store/duckdb.js";
import { insertProject } from "./store/projects.js";
import { insertSource } from "./store/sources.js";
import { getLatestArtifactByKind } from "./store/artifacts.js";
import { writeArtifact } from "./tools/rules.js";
import { DqSpecSchema, DQ_TARGET_TABLE, distinctCheckTypes } from "./core/dq.js";
import type { DqClient } from "./pipeline/dq.js";

/**
 * Route tests for `POST /api/projects/:id/dq` (T3.4, FR7). They exercise the full route +
 * persist path against a real in-memory warehouse and a real CSV on disk; only the external
 * model call is mocked (a canned DQ JSON), the honest boundary for a non-deterministic LLM.
 * They assert the desired result — a validated ≥3-check spec covering the four types returned
 * and persisted as a `dq_spec` artifact — plus every status the route maps: 400, 404, 422,
 * 502, 503.
 */
describe("dq route", () => {
  const open: WarehouseStore[] = [];
  const tmpDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(open.splice(0).map((s) => s.close()));
    await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  const LOANS_CSV =
    "loan_id,branch,balance,opened_at\n" +
    "1,north,1000.50,2024-01-01\n" +
    "2,south,,2024-01-02\n" +
    "3,north,750.25,2024-02-15\n";

  const DQ = {
    targetTable: DQ_TARGET_TABLE,
    checks: [
      { name: "rows present", type: "row_count", column: null, description: "at least one row" },
      { name: "id not null", type: "not_null", column: "loan_id", description: "loan_id never null" },
      { name: "branch present", type: "schema", column: "branch", description: "branch column exists" },
      { name: "recent", type: "freshness", column: "opened_at", description: "opened_at is recent" },
    ],
  };

  /** A mock DQ generator whose prompt returns `text` (defaults to a valid DQ JSON). */
  function mockDq(
    text: string = JSON.stringify(DQ),
    opts: { promptError?: unknown } = {},
  ) {
    const prompt = vi.fn(async () =>
      opts.promptError
        ? { data: undefined, error: opts.promptError }
        : {
            data: {
              info: {},
              parts: [{ id: "p-0", sessionID: "s", messageID: "m", type: "text" as const, text }],
            },
            error: undefined,
          },
    );
    const create = vi.fn(async () => ({ data: { id: "sess-1" }, error: undefined }));
    return { session: { create, prompt } } as unknown as DqClient;
  }

  async function csvFile(contents: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "dq-route-"));
    tmpDirs.push(dir);
    const path = join(dir, "loans.csv");
    await writeFile(path, contents);
    return path;
  }

  async function fixtures(dqGenerator: DqClient = mockDq()) {
    const store = await openStore(":memory:");
    open.push(store);
    const artifactsDir = await mkdtemp(join(tmpdir(), "dq-artifacts-"));
    tmpDirs.push(artifactsDir);
    const project = await insertProject(store, {
      name: "Loan Book",
      domain: "lending",
      warehouse: "duckdb",
    });
    const app = buildServer({ store, dqGenerator, artifactsDir });
    return { app, store, projectId: project.id, artifactsDir };
  }

  /** Persist a `rules` artifact (optional for DQ, but exercises the rules-carrying path). */
  async function saveRules(store: WarehouseStore, dir: string, projectId: string) {
    await writeArtifact(store, {
      dir,
      projectId,
      kind: "rules",
      name: "rules.txt",
      content: "Aggregate total balance by branch.",
    });
  }

  it("generates ≥3 checks and persists a dq_spec artifact", async () => {
    const { app, store, projectId, artifactsDir } = await fixtures();
    const path = await csvFile(LOANS_CSV);
    await insertSource(store, { id: "s-1", projectId, path, originalFilename: "loans.csv" });
    await saveRules(store, artifactsDir, projectId);

    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/dq`,
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { dq: unknown; artifact: { kind: string; content: string } };

    // The returned spec validates against the FR7 contract: ≥3 checks, ≥3 distinct types.
    const spec = DqSpecSchema.parse(body.dq);
    expect(spec.checks.length).toBeGreaterThanOrEqual(3);
    expect(distinctCheckTypes(spec).length).toBeGreaterThanOrEqual(3);

    // A `dq_spec` artifact was persisted, and its stored content parses back to the same.
    expect(body.artifact.kind).toBe("dq_spec");
    const stored = await getLatestArtifactByKind(store, projectId, "dq_spec");
    expect(stored).not.toBeNull();
    expect(DqSpecSchema.parse(JSON.parse(stored!.content!)).targetTable).toBe(DQ_TARGET_TABLE);
    // The artifact was written to disk too.
    const onDisk = await readFile(stored!.path!, "utf8");
    expect(DqSpecSchema.parse(JSON.parse(onDisk)).checks.length).toBeGreaterThanOrEqual(3);
  });

  it("generates checks even when no rules are on file (rules are optional for DQ)", async () => {
    const { app, store, projectId } = await fixtures();
    const path = await csvFile(LOANS_CSV);
    await insertSource(store, { id: "s-1", projectId, path, originalFilename: "loans.csv" });

    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/dq`,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
  });

  it("generates checks for a named source when sourceId is given", async () => {
    const { app, store, projectId } = await fixtures();
    const path = await csvFile(LOANS_CSV);
    await insertSource(store, { id: "s-target", projectId, path, originalFilename: "loans.csv" });

    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/dq`,
      payload: { sourceId: "s-target" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("400s when the project has no source to generate checks from", async () => {
    // fixtures() creates a project but no source, so the newest-source lookup finds nothing.
    const { app, projectId } = await fixtures();
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/dq`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("404s an unknown project", async () => {
    const { app } = await fixtures();
    const res = await app.inject({ method: "POST", url: "/api/projects/nope/dq", payload: {} });
    expect(res.statusCode).toBe(404);
  });

  it("404s a sourceId that belongs to another project", async () => {
    const { app, store, projectId } = await fixtures();
    const other = await insertProject(store, { name: "Other", domain: "lending", warehouse: "duckdb" });
    const path = await csvFile(LOANS_CSV);
    await insertSource(store, { id: "s-other", projectId: other.id, path, originalFilename: "loans.csv" });

    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/dq`,
      payload: { sourceId: "s-other" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("422s when the source CSV cannot be read", async () => {
    const { app, store, projectId } = await fixtures();
    await insertSource(store, {
      id: "s-missing",
      projectId,
      path: join(tmpdir(), "definitely-not-here-dq.csv"),
      originalFilename: "gone.csv",
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/dq`,
      payload: {},
    });
    expect(res.statusCode).toBe(422);
  });

  it("422s when the model output is not a valid spec", async () => {
    const { app, store, projectId } = await fixtures(mockDq("I cannot produce checks."));
    const path = await csvFile(LOANS_CSV);
    await insertSource(store, { id: "s-1", projectId, path, originalFilename: "loans.csv" });

    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/dq`,
      payload: {},
    });
    expect(res.statusCode).toBe(422);
    // A bad model output must not leave a persisted DQ artifact behind.
    expect(await getLatestArtifactByKind(store, projectId, "dq_spec")).toBeNull();
  });

  it("422s when the spec has too few checks", async () => {
    const tooFew = JSON.stringify({
      targetTable: DQ_TARGET_TABLE,
      checks: [{ name: "rows", type: "row_count", column: null, description: "rows present" }],
    });
    const { app, store, projectId } = await fixtures(mockDq(tooFew));
    const path = await csvFile(LOANS_CSV);
    await insertSource(store, { id: "s-1", projectId, path, originalFilename: "loans.csv" });

    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/dq`,
      payload: {},
    });
    expect(res.statusCode).toBe(422);
    expect(await getLatestArtifactByKind(store, projectId, "dq_spec")).toBeNull();
  });

  it("502s when the agent runtime fails the prompt", async () => {
    const dq = mockDq("", { promptError: { message: "model unavailable" } });
    const { app, store, projectId } = await fixtures(dq);
    const path = await csvFile(LOANS_CSV);
    await insertSource(store, { id: "s-1", projectId, path, originalFilename: "loans.csv" });

    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/dq`,
      payload: {},
    });
    expect(res.statusCode).toBe(502);
  });

  it("400s an invalid body type", async () => {
    const { app, projectId } = await fixtures();
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/dq`,
      payload: { model: 123 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("503s when the store is unwired", async () => {
    const app = buildServer({ dqGenerator: mockDq() });
    const res = await app.inject({ method: "POST", url: "/api/projects/p/dq", payload: {} });
    expect(res.statusCode).toBe(503);
  });

  it("503s when the dq generator is unwired", async () => {
    const store = await openStore(":memory:");
    open.push(store);
    const app = buildServer({ store });
    const res = await app.inject({ method: "POST", url: "/api/projects/p/dq", payload: {} });
    expect(res.statusCode).toBe(503);
  });
});
