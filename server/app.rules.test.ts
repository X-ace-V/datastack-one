import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "./app.js";
import { openStore, type WarehouseStore } from "./store/duckdb.js";
import { insertProject } from "./store/projects.js";
import { ArtifactSchema, RulesResponseSchema } from "./core/artifacts.js";

/**
 * Route tests for `POST /api/projects/:id/rules` and `GET /api/projects/:id/rules` (T3.1,
 * FR6). Both rules-input forms are proven: a JSON textarea body via `app.inject`, and a real
 * multipart file upload over a live socket (the honest path, since `app.inject` can't stream
 * multipart). The negative paths (404, 400, 503) and the latest-wins GET are covered too.
 */
describe("rules routes", () => {
  const open: WarehouseStore[] = [];
  const tmpDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(open.splice(0).map((s) => s.close()));
    await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function fixtures() {
    const store = await openStore(":memory:");
    open.push(store);
    const artifactsDir = await mkdtemp(join(tmpdir(), "datastack-artifacts-"));
    tmpDirs.push(artifactsDir);
    const project = await insertProject(store, {
      name: "Loan Book",
      domain: "lending",
      warehouse: "duckdb",
    });
    const app = buildServer({ store, artifactsDir });
    return { app, store, artifactsDir, projectId: project.id };
  }

  const RULES = "Keep only active loans.\nDrop rows with dpd_days > 90.\n";

  it("stores rules submitted as a JSON textarea body and returns the artifact", async () => {
    const { app, projectId } = await fixtures();
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/rules`,
      payload: { rules: RULES },
    });

    expect(res.statusCode).toBe(201);
    const artifact = ArtifactSchema.parse(res.json());
    expect(artifact.projectId).toBe(projectId);
    expect(artifact.kind).toBe("rules");
    // The JSON textarea path trims surrounding whitespace before storing.
    expect(artifact.content).toBe(RULES.trim());

    // The rules text was written to disk at the recorded path.
    expect(await readFile(artifact.path!, "utf8")).toBe(RULES.trim());

    // And GET returns it as the current rules doc.
    const got = await app.inject({ method: "GET", url: `/api/projects/${projectId}/rules` });
    expect(got.statusCode).toBe(200);
    const body = RulesResponseSchema.parse(got.json());
    expect(body.rules?.id).toBe(artifact.id);
    expect(body.rules?.content).toBe(RULES.trim());
  });

  it("stores rules submitted as a multipart file upload", async () => {
    const { app, projectId } = await fixtures();
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    try {
      const form = new FormData();
      form.append("file", new Blob([RULES], { type: "text/plain" }), "loan_rules.txt");
      const res = await fetch(`${address}/api/projects/${projectId}/rules`, {
        method: "POST",
        body: form,
      });

      expect(res.status).toBe(201);
      const artifact = ArtifactSchema.parse(await res.json());
      expect(artifact.kind).toBe("rules");
      expect(artifact.content).toBe(RULES);
      expect(await readFile(artifact.path!, "utf8")).toBe(RULES);
    } finally {
      await app.close();
    }
  });

  it("returns the newest rules doc when several were submitted", async () => {
    const { app, projectId } = await fixtures();
    await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/rules`,
      payload: { rules: "first version" },
    });
    const second = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/rules`,
      payload: { rules: "second version" },
    });
    const newest = ArtifactSchema.parse(second.json());

    const got = await app.inject({ method: "GET", url: `/api/projects/${projectId}/rules` });
    const body = RulesResponseSchema.parse(got.json());
    expect(body.rules?.id).toBe(newest.id);
    expect(body.rules?.content).toBe("second version");
  });

  it("returns null rules when none have been submitted", async () => {
    const { app, projectId } = await fixtures();
    const got = await app.inject({ method: "GET", url: `/api/projects/${projectId}/rules` });
    expect(got.statusCode).toBe(200);
    expect(RulesResponseSchema.parse(got.json()).rules).toBeNull();
  });

  it("rejects a whitespace-only JSON submission with 400", async () => {
    const { app, projectId } = await fixtures();
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/rules`,
      payload: { rules: "   \n\t " },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 404 posting rules to an unknown project", async () => {
    const { app } = await fixtures();
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/does-not-exist/rules",
      payload: { rules: RULES },
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 404 getting rules for an unknown project", async () => {
    const { app } = await fixtures();
    const res = await app.inject({ method: "GET", url: "/api/projects/nope/rules" });
    expect(res.statusCode).toBe(404);
  });

  it("reports 503 when the store is unwired", async () => {
    const app = buildServer({});
    const post = await app.inject({
      method: "POST",
      url: "/api/projects/p/rules",
      payload: { rules: RULES },
    });
    expect(post.statusCode).toBe(503);
    const get = await app.inject({ method: "GET", url: "/api/projects/p/rules" });
    expect(get.statusCode).toBe(503);
  });
});
