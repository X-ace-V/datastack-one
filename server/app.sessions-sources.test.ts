import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "./app.js";
import { openStore, type WarehouseStore } from "./store/duckdb.js";
import { insertSession } from "./store/sessions.js";
import { getSessionSource } from "./store/session-sources.js";
import { SessionSourceViewSchema } from "./core/session-sources.js";

/**
 * Route tests for `POST /api/sessions/:id/sources` (V3.2, FR4). The upload is exercised over a
 * real socket with a real multipart body (`fetch` + `FormData`) — `app.inject` can't stream a
 * multipart body — so the test proves the file lands on disk with the uploaded bytes, is loaded
 * in DuckDB (the returned row count is the real scan), is registered under a name derived from
 * the filename, and is then visible to BOTH agent tools (`list_sources`/`profile_source`) via the
 * loopback routes. The response withholds the on-disk `path` (FR5b). Negative paths (503, 400,
 * 404) use `app.inject`.
 */
describe("session CSV source upload route", () => {
  const open: WarehouseStore[] = [];
  const tmpDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(open.splice(0).map((s) => s.close()));
    await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function fixtures() {
    const store = await openStore(":memory:");
    open.push(store);
    const uploadsDir = await mkdtemp(join(tmpdir(), "datastack-session-uploads-"));
    tmpDirs.push(uploadsDir);
    const session = await insertSession(store, { id: "ses_1", title: "Loan work" });
    const app = buildServer({ store, uploadsDir });
    return { app, store, uploadsDir, sessionId: session.id };
  }

  // A synthetic lending source: a unique key (loan_id), a null in balance, a DATE column.
  const CSV =
    "loan_id,customer_id,branch,balance,opened_at\n" +
    "1,100,north,1000.50,2024-01-01\n" +
    "2,101,south,,2024-01-02\n" +
    "3,100,north,750.25,2024-02-15\n";

  it("uploads a CSV, loads+registers it, and both agent tools then see it", async () => {
    const { app, store, sessionId } = await fixtures();
    const address = await app.listen({ port: 0, host: "127.0.0.1" });

    try {
      const form = new FormData();
      form.append("file", new Blob([CSV], { type: "text/csv" }), "loans.csv");
      const res = await fetch(`${address}/api/sessions/${sessionId}/sources`, {
        method: "POST",
        body: form,
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as { source: unknown };
      const view = SessionSourceViewSchema.parse(body.source);
      expect(view.sessionId).toBe(sessionId);
      expect(view.name).toBe("loans");
      expect(view.kind).toBe("csv");
      // The row count is the real DuckDB scan (3 data rows), proving loadability.
      expect(view.rowCount).toBe(3);
      // FR5b: the response never carries the on-disk path.
      expect(body.source).not.toHaveProperty("path");

      // Registered in the store with the resolved path holding exactly the uploaded bytes.
      const stored = await getSessionSource(store, sessionId, "loans");
      expect(stored?.rowCount).toBe(3);
      expect(await readFile(stored!.path, "utf8")).toBe(CSV);

      // list_sources (the agent tool loopback) now returns the model-safe view — no path.
      const list = await fetch(`${address}/api/internal/tools/list_sources`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionID: sessionId }),
      });
      const listBody = (await list.json()) as {
        sources: { name: string; kind: string; rowCount: number | null }[];
      };
      expect(listBody.sources).toContainEqual({ name: "loans", kind: "csv", rowCount: 3 });
      expect(JSON.stringify(listBody)).not.toContain(stored!.path);

      // profile_source resolves the name → path backend-side and returns the FR6 profile.
      const profile = await fetch(`${address}/api/internal/tools/profile_source`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionID: sessionId, source: "loans" }),
      });
      expect(profile.status).toBe(200);
      const profileBody = (await profile.json()) as {
        source: string;
        profile: { rowCount: number; candidateKeys: string[]; dateColumns: string[] };
      };
      expect(profileBody.source).toBe("loans");
      expect(profileBody.profile.rowCount).toBe(3);
      expect(profileBody.profile.candidateKeys).toContain("loan_id");
      expect(profileBody.profile.dateColumns).toContain("opened_at");
    } finally {
      await app.close();
    }
  });

  it("re-uploading the same filename replaces the source in place (upsert)", async () => {
    const { app, store, sessionId } = await fixtures();
    const address = await app.listen({ port: 0, host: "127.0.0.1" });

    try {
      async function upload(contents: string) {
        const form = new FormData();
        form.append("file", new Blob([contents], { type: "text/csv" }), "loans.csv");
        return fetch(`${address}/api/sessions/${sessionId}/sources`, {
          method: "POST",
          body: form,
        });
      }

      await upload("loan_id,branch\n1,north\n");
      const second = await upload("loan_id,branch\n1,north\n2,south\n3,west\n");
      expect(second.status).toBe(201);

      // Exactly one "loans" source, now reflecting the second upload's row count.
      const list = await fetch(`${address}/api/internal/tools/list_sources`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionID: sessionId }),
      });
      const listBody = (await list.json()) as { sources: { name: string; rowCount: number }[] };
      const loans = listBody.sources.filter((s) => s.name === "loans");
      expect(loans).toHaveLength(1);
      expect(loans[0]?.rowCount).toBe(3);
      const stored = await getSessionSource(store, sessionId, "loans");
      expect(stored?.rowCount).toBe(3);
    } finally {
      await app.close();
    }
  });

  it("rejects a non-CSV file with 400", async () => {
    const { app, sessionId } = await fixtures();
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    try {
      const form = new FormData();
      form.append("file", new Blob(["nope"], { type: "text/plain" }), "notes.txt");
      const res = await fetch(`${address}/api/sessions/${sessionId}/sources`, {
        method: "POST",
        body: form,
      });
      expect(res.status).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("rejects an empty file with 400", async () => {
    const { app, sessionId } = await fixtures();
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    try {
      const form = new FormData();
      form.append("file", new Blob([""], { type: "text/csv" }), "empty.csv");
      const res = await fetch(`${address}/api/sessions/${sessionId}/sources`, {
        method: "POST",
        body: form,
      });
      expect(res.status).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("returns 404 when the session does not exist", async () => {
    const { app } = await fixtures();
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/does-not-exist/sources",
      headers: { "content-type": "multipart/form-data; boundary=x" },
      payload: "--x--\r\n",
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 400 when the request is not multipart", async () => {
    const { app, sessionId } = await fixtures();
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/sources`,
      payload: { not: "multipart" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("reports 503 when the store is unwired", async () => {
    const app = buildServer({});
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/ses_1/sources",
      headers: { "content-type": "multipart/form-data; boundary=x" },
      payload: "--x--\r\n",
    });
    expect(res.statusCode).toBe(503);
  });
});
