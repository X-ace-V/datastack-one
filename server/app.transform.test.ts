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
import { TransformSchema } from "./core/transform.js";
import type { TransformClient } from "./pipeline/transform.js";

/**
 * Route tests for `POST /api/projects/:id/transform` (T3.3, FR6). They exercise the full route +
 * persist path against a real in-memory warehouse and a real CSV on disk; only the external
 * model call is mocked (a canned transform JSON), the honest boundary for a non-deterministic
 * LLM. They assert the desired result — a validated transform returned and persisted as a
 * `transform_sql` artifact with the surfaced assumptions/questions — plus every status the route
 * maps: 400 (no source / no rules / bad body), 404, 422, 502, 503.
 */
describe("transform route", () => {
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

  const TRANSFORM = {
    sql: "CREATE OR REPLACE TABLE marts.loan_summary AS SELECT branch, sum(balance) AS total FROM raw.source GROUP BY branch;",
    targetTable: "loan_summary",
    assumptions: ["A null balance is treated as zero."],
    questions: ["Should closed loans be excluded?"],
  };

  /** A mock transformer whose prompt returns `text` (defaults to a valid transform JSON). */
  function mockTransformer(
    text: string = JSON.stringify(TRANSFORM),
    opts: { promptError?: unknown } = {},
  ) {
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
    return { session: { create, prompt } } as unknown as TransformClient;
  }

  async function csvFile(contents: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "transform-route-"));
    tmpDirs.push(dir);
    const path = join(dir, "loans.csv");
    await writeFile(path, contents);
    return path;
  }

  async function fixtures(transformer: TransformClient = mockTransformer()) {
    const store = await openStore(":memory:");
    open.push(store);
    const artifactsDir = await mkdtemp(join(tmpdir(), "transform-artifacts-"));
    tmpDirs.push(artifactsDir);
    const project = await insertProject(store, {
      name: "Loan Book",
      domain: "lending",
      warehouse: "duckdb",
    });
    const app = buildServer({ store, transformer, artifactsDir });
    return { app, store, projectId: project.id, artifactsDir };
  }

  /** Persist a `rules` artifact so the transform route has rules to generate from. */
  async function saveRules(store: WarehouseStore, dir: string, projectId: string) {
    await writeArtifact(store, {
      dir,
      projectId,
      kind: "rules",
      name: "rules.txt",
      content: "Aggregate total balance by branch.",
    });
  }

  it("generates a transform and persists a transform_sql artifact", async () => {
    const { app, store, projectId, artifactsDir } = await fixtures();
    const path = await csvFile(LOANS_CSV);
    await insertSource(store, { id: "s-1", projectId, path, originalFilename: "loans.csv" });
    await saveRules(store, artifactsDir, projectId);

    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/transform`,
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      transform: unknown;
      artifact: { kind: string; content: string };
    };

    // The returned transform validates against the FR6 contract and surfaces assumptions/questions.
    const transform = TransformSchema.parse(body.transform);
    expect(transform.targetTable).toBe("loan_summary");
    expect(transform.sql).toContain("marts.loan_summary");
    expect(transform.assumptions.length).toBeGreaterThan(0);
    expect(transform.questions.length).toBeGreaterThan(0);

    // A `transform_sql` artifact was persisted, and its stored content parses back to the same.
    expect(body.artifact.kind).toBe("transform_sql");
    const stored = await getLatestArtifactByKind(store, projectId, "transform_sql");
    expect(stored).not.toBeNull();
    expect(TransformSchema.parse(JSON.parse(stored!.content!))).toMatchObject({
      targetTable: "loan_summary",
    });
    // The artifact was written to disk too.
    const onDisk = await readFile(stored!.path!, "utf8");
    expect(TransformSchema.parse(JSON.parse(onDisk)).sql).toContain("marts.loan_summary");
  });

  it("transforms a named source when sourceId is given", async () => {
    const { app, store, projectId, artifactsDir } = await fixtures();
    const path = await csvFile(LOANS_CSV);
    await insertSource(store, { id: "s-target", projectId, path, originalFilename: "loans.csv" });
    await saveRules(store, artifactsDir, projectId);

    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/transform`,
      payload: { sourceId: "s-target" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("400s when the project has no source to transform", async () => {
    const { app, store, projectId, artifactsDir } = await fixtures();
    await saveRules(store, artifactsDir, projectId);
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/transform`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("400s when the project has no rules on file", async () => {
    const { app, store, projectId } = await fixtures();
    const path = await csvFile(LOANS_CSV);
    await insertSource(store, { id: "s-1", projectId, path, originalFilename: "loans.csv" });

    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/transform`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    // No transform artifact is left behind when generation never ran.
    expect(await getLatestArtifactByKind(store, projectId, "transform_sql")).toBeNull();
  });

  it("404s an unknown project", async () => {
    const { app } = await fixtures();
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/nope/transform",
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });

  it("404s a sourceId that belongs to another project", async () => {
    const { app, store, projectId, artifactsDir } = await fixtures();
    await saveRules(store, artifactsDir, projectId);
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
      url: `/api/projects/${projectId}/transform`,
      payload: { sourceId: "s-other" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("422s when the source CSV cannot be read", async () => {
    const { app, store, projectId, artifactsDir } = await fixtures();
    await saveRules(store, artifactsDir, projectId);
    await insertSource(store, {
      id: "s-missing",
      projectId,
      path: join(tmpdir(), "definitely-not-here-transform.csv"),
      originalFilename: "gone.csv",
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/transform`,
      payload: {},
    });
    expect(res.statusCode).toBe(422);
  });

  it("422s when the model output is not a valid transform", async () => {
    const { app, store, projectId, artifactsDir } = await fixtures(
      mockTransformer("I cannot produce SQL."),
    );
    const path = await csvFile(LOANS_CSV);
    await insertSource(store, { id: "s-1", projectId, path, originalFilename: "loans.csv" });
    await saveRules(store, artifactsDir, projectId);

    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/transform`,
      payload: {},
    });
    expect(res.statusCode).toBe(422);
    // A bad model output must not leave a persisted transform artifact behind.
    expect(await getLatestArtifactByKind(store, projectId, "transform_sql")).toBeNull();
  });

  it("502s when the agent runtime fails the prompt", async () => {
    const transformer = mockTransformer("", { promptError: { message: "model unavailable" } });
    const { app, store, projectId, artifactsDir } = await fixtures(transformer);
    const path = await csvFile(LOANS_CSV);
    await insertSource(store, { id: "s-1", projectId, path, originalFilename: "loans.csv" });
    await saveRules(store, artifactsDir, projectId);

    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/transform`,
      payload: {},
    });
    expect(res.statusCode).toBe(502);
  });

  it("400s an invalid body type", async () => {
    const { app, projectId } = await fixtures();
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/transform`,
      payload: { model: 123 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("503s when the store is unwired", async () => {
    const app = buildServer({ transformer: mockTransformer() });
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/p/transform",
      payload: {},
    });
    expect(res.statusCode).toBe(503);
  });

  it("503s when the transformer is unwired", async () => {
    const store = await openStore(":memory:");
    open.push(store);
    const app = buildServer({ store });
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/p/transform",
      payload: {},
    });
    expect(res.statusCode).toBe(503);
  });
});
