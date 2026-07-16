import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "./app.js";
import { openStore, type WarehouseStore } from "./store/duckdb.js";
import { insertProject } from "./store/projects.js";
import { SourceSchema } from "./core/sources.js";

/**
 * Route tests for `POST /api/projects/:id/source` and `GET /api/projects/:id/sources`
 * (T2.2, FR2). The upload is exercised over a real socket with a real multipart body
 * (`fetch` + `FormData`) — the honest path — so the test proves the file actually lands on
 * disk with the uploaded bytes and a schema-valid row comes back. The negative paths (404,
 * 400, 503) use `app.inject`.
 */
describe("source upload routes", () => {
  const open: WarehouseStore[] = [];
  const tmpDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(open.splice(0).map((s) => s.close()));
    await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function fixtures() {
    const store = await openStore(":memory:");
    open.push(store);
    const uploadsDir = await mkdtemp(join(tmpdir(), "datastack-uploads-"));
    tmpDirs.push(uploadsDir);
    const project = await insertProject(store, {
      name: "Loan Book",
      domain: "lending",
      warehouse: "duckdb",
    });
    const app = buildServer({ store, uploadsDir });
    return { app, store, uploadsDir, projectId: project.id };
  }

  const CSV = "customer_id,loan_amount\n1,1000\n2,2000\n";

  it("uploads a CSV, persists it, and writes the bytes to disk", async () => {
    const { app, projectId } = await fixtures();
    const address = await app.listen({ port: 0, host: "127.0.0.1" });

    try {
      const form = new FormData();
      form.append("file", new Blob([CSV], { type: "text/csv" }), "loans.csv");
      const res = await fetch(`${address}/api/projects/${projectId}/source`, {
        method: "POST",
        body: form,
      });

      expect(res.status).toBe(201);
      const source = SourceSchema.parse(await res.json());
      expect(source.projectId).toBe(projectId);
      expect(source.originalFilename).toBe("loans.csv");
      expect(source.kind).toBe("csv");
      expect(source.rowCount).toBeNull();

      // The stored path holds exactly the uploaded bytes.
      const onDisk = await readFile(source.path, "utf8");
      expect(onDisk).toBe(CSV);

      // And the source is now listed for the project.
      const list = await fetch(`${address}/api/projects/${projectId}/sources`);
      const body = (await list.json()) as { sources: unknown[] };
      const sources = body.sources.map((s) => SourceSchema.parse(s));
      expect(sources.map((s) => s.id)).toContain(source.id);
    } finally {
      await app.close();
    }
  });

  it("rejects a non-CSV file with 400", async () => {
    const { app, projectId } = await fixtures();
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    try {
      const form = new FormData();
      form.append("file", new Blob(["nope"], { type: "text/plain" }), "notes.txt");
      const res = await fetch(`${address}/api/projects/${projectId}/source`, {
        method: "POST",
        body: form,
      });
      expect(res.status).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("rejects an empty file with 400", async () => {
    const { app, projectId } = await fixtures();
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    try {
      const form = new FormData();
      form.append("file", new Blob([""], { type: "text/csv" }), "empty.csv");
      const res = await fetch(`${address}/api/projects/${projectId}/source`, {
        method: "POST",
        body: form,
      });
      expect(res.status).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("returns 404 when the project does not exist", async () => {
    const { app } = await fixtures();
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/does-not-exist/source",
      headers: { "content-type": "multipart/form-data; boundary=x" },
      payload: "--x--\r\n",
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 400 when the request is not multipart", async () => {
    const { app, projectId } = await fixtures();
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/source`,
      payload: { not: "multipart" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("reports 503 for upload when the store is unwired", async () => {
    const app = buildServer({});
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/p/source",
      headers: { "content-type": "multipart/form-data; boundary=x" },
      payload: "--x--\r\n",
    });
    expect(res.statusCode).toBe(503);
  });

  it("returns 404 listing sources for an unknown project", async () => {
    const { app } = await fixtures();
    const res = await app.inject({
      method: "GET",
      url: "/api/projects/nope/sources",
    });
    expect(res.statusCode).toBe(404);
  });

  it("reports 503 for list when the store is unwired", async () => {
    const app = buildServer({});
    const res = await app.inject({ method: "GET", url: "/api/projects/p/sources" });
    expect(res.statusCode).toBe(503);
  });
});
