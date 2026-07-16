import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "./app.js";
import { openStore, type WarehouseStore } from "./store/duckdb.js";
import { insertProject } from "./store/projects.js";
import { getSource, insertSource } from "./store/sources.js";
import { SourceProfileSchema } from "./core/profile.js";

/**
 * Route tests for `POST /api/projects/:id/profile` (T2.4, FR2). The profile stage runs the
 * real `profile_source` tool against a CSV on disk, so these use `app.inject` (no streaming)
 * against a real in-memory warehouse and real fixture files. They assert the desired result
 * — the FR2 profile shape and values — plus the row-count persisted back onto the source, and
 * the 404/400/503 paths.
 */
describe("profile route", () => {
  const open: WarehouseStore[] = [];
  const tmpDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(open.splice(0).map((s) => s.close()));
    await Promise.all(
      tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
    );
  });

  // A synthetic lending source: unique key (loan_id), a null in balance, a DATE column.
  const LOANS_CSV =
    "loan_id,customer_id,branch,balance,opened_at\n" +
    "1,100,north,1000.50,2024-01-01\n" +
    "2,101,south,,2024-01-02\n" +
    "3,100,north,750.25,2024-02-15\n" +
    "4,102,west,500.00,2024-03-10\n";

  async function csvFile(name: string, contents: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "profile-route-"));
    tmpDirs.push(dir);
    const path = join(dir, name);
    await writeFile(path, contents);
    return path;
  }

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

  it("profiles the newest source and persists its row count", async () => {
    const { app, store, projectId } = await fixtures();
    const path = await csvFile("loans_sample.csv", LOANS_CSV);
    const source = await insertSource(store, {
      id: "s-1",
      projectId,
      path,
      originalFilename: "loans_sample.csv",
    });
    expect(source.rowCount).toBeNull();

    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/profile`,
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { source: { id: string; rowCount: number }; profile: unknown };

    // The profile validates against the FR2 contract and carries the expected values.
    const profile = SourceProfileSchema.parse(body.profile);
    expect(profile.rowCount).toBe(4);
    expect(profile.columnCount).toBe(5);
    expect(profile.candidateKeys).toContain("loan_id");
    expect(profile.dateColumns).toEqual(["opened_at"]);
    const byName = Object.fromEntries(profile.columns.map((c) => [c.name, c]));
    expect(byName.balance?.nullPercent).toBe(25);

    // The row count is persisted back onto the source, both in the response and in storage.
    expect(body.source.id).toBe("s-1");
    expect(body.source.rowCount).toBe(4);
    const reread = await getSource(store, "s-1");
    expect(reread?.rowCount).toBe(4);
  });

  it("profiles a named source when sourceId is given", async () => {
    const { app, store, projectId } = await fixtures();
    const path = await csvFile("named.csv", LOANS_CSV);
    await insertSource(store, {
      id: "s-target",
      projectId,
      path,
      originalFilename: "named.csv",
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/profile`,
      payload: { sourceId: "s-target" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { source: { id: string } };
    expect(body.source.id).toBe("s-target");
  });

  it("accepts a request with no body at all", async () => {
    const { app, store, projectId } = await fixtures();
    const path = await csvFile("loans.csv", LOANS_CSV);
    await insertSource(store, { id: "s-1", projectId, path, originalFilename: "loans.csv" });

    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/profile`,
    });
    expect(res.statusCode).toBe(200);
  });

  it("400s when the project has no source to profile", async () => {
    const { app, projectId } = await fixtures();
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/profile`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("404s an unknown project", async () => {
    const { app } = await fixtures();
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/does-not-exist/profile",
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });

  it("404s a sourceId that belongs to another project", async () => {
    const { app, store, projectId } = await fixtures();
    const otherProject = await insertProject(store, {
      name: "Other",
      domain: "lending",
      warehouse: "duckdb",
    });
    const path = await csvFile("other.csv", LOANS_CSV);
    await insertSource(store, {
      id: "s-other",
      projectId: otherProject.id,
      path,
      originalFilename: "other.csv",
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/profile`,
      payload: { sourceId: "s-other" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("422s when the source file cannot be read", async () => {
    const { app, store, projectId } = await fixtures();
    await insertSource(store, {
      id: "s-missing",
      projectId,
      path: join(tmpdir(), "definitely-not-here-xyz.csv"),
      originalFilename: "gone.csv",
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/profile`,
      payload: {},
    });
    expect(res.statusCode).toBe(422);
  });

  it("400s an invalid sourceId type", async () => {
    const { app, projectId } = await fixtures();
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/profile`,
      payload: { sourceId: 123 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("503s when the store is unwired", async () => {
    const app = buildServer({});
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/p/profile",
      payload: {},
    });
    expect(res.statusCode).toBe(503);
  });
});
