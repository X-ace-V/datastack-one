import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "./app.js";
import { openStore, type WarehouseStore } from "./store/duckdb.js";
import { registerSessionSource } from "./store/session-sources.js";

/**
 * Route tests for the agent-tool loopback (V3.1, FR4/FR6): `POST /api/internal/tools/list_sources`
 * and `POST /api/internal/tools/profile_source`. These are what the OpenCode plugin calls back
 * into; they run the real store + real `profile_source` against a CSV on disk. Driven with
 * `app.inject` over a real in-memory warehouse. They assert the desired values (the model-safe
 * source list with NO path, the FR2 profile shape) plus the 404/422/400/503 branches.
 */
describe("internal tool routes", () => {
  const open: WarehouseStore[] = [];
  const tmpDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(open.splice(0).map((s) => s.close()));
    await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  // A synthetic lending source: unique key (loan_id), a null in balance, a DATE column.
  const LOANS_CSV =
    "loan_id,customer_id,branch,balance,opened_at\n" +
    "1,100,north,1000.50,2024-01-01\n" +
    "2,101,south,,2024-01-02\n" +
    "3,100,north,750.25,2024-02-15\n" +
    "4,102,west,500.00,2024-03-10\n";

  async function csvFile(name: string, contents: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "internal-tools-"));
    tmpDirs.push(dir);
    const path = join(dir, name);
    await writeFile(path, contents);
    return path;
  }

  async function fixtures() {
    const store = await openStore(":memory:");
    open.push(store);
    const app = buildServer({ store });
    return { app, store };
  }

  it("list_sources returns model-safe views (name/kind/rowCount, no path)", async () => {
    const { app, store } = await fixtures();
    await registerSessionSource(store, {
      sessionId: "ses_1",
      name: "loans",
      path: "/tmp/secret/ses_1-loans.csv",
      rowCount: 24,
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/internal/tools/list_sources",
      payload: { sessionID: "ses_1" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sources: [{ name: "loans", kind: "csv", rowCount: 24 }] });
    // The on-disk path must not leak to the model over this hop (FR5b).
    expect(res.body).not.toContain("secret");
  });

  it("list_sources returns an empty list for a session with no sources", async () => {
    const { app } = await fixtures();
    const res = await app.inject({
      method: "POST",
      url: "/api/internal/tools/list_sources",
      payload: { sessionID: "ses_empty" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sources: [] });
  });

  it("list_sources scopes to the requesting session", async () => {
    const { app, store } = await fixtures();
    await registerSessionSource(store, { sessionId: "ses_1", name: "loans", path: "/tmp/a.csv" });
    await registerSessionSource(store, { sessionId: "ses_2", name: "other", path: "/tmp/b.csv" });

    const res = await app.inject({
      method: "POST",
      url: "/api/internal/tools/list_sources",
      payload: { sessionID: "ses_1" },
    });
    expect(res.json().sources.map((s: { name: string }) => s.name)).toEqual(["loans"]);
  });

  it("profile_source profiles a named source with the FR2 values", async () => {
    const { app, store } = await fixtures();
    const path = await csvFile("loans.csv", LOANS_CSV);
    await registerSessionSource(store, { sessionId: "ses_1", name: "loans", path });

    const res = await app.inject({
      method: "POST",
      url: "/api/internal/tools/profile_source",
      payload: { sessionID: "ses_1", source: "loans" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.source).toBe("loans");
    expect(body.profile.rowCount).toBe(4);
    expect(body.profile.columnCount).toBe(5);
    // loan_id is unique + non-null → candidate key; balance has one null; opened_at is a date.
    expect(body.profile.candidateKeys).toContain("loan_id");
    expect(body.profile.dateColumns).toContain("opened_at");
    const balance = body.profile.columns.find(
      (c: { name: string }) => c.name === "balance",
    );
    expect(balance.nullPercent).toBe(25);
    // The resolved path is not echoed back to the model.
    expect(res.body).not.toContain(path);
  });

  it("profile_source 404s when no source of that name is connected to the session", async () => {
    const { app, store } = await fixtures();
    // A source with this name exists — but in a different session.
    const path = await csvFile("loans.csv", LOANS_CSV);
    await registerSessionSource(store, { sessionId: "ses_other", name: "loans", path });

    const res = await app.inject({
      method: "POST",
      url: "/api/internal/tools/profile_source",
      payload: { sessionID: "ses_1", source: "loans" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("profile_source 422s when the named source's file cannot be read", async () => {
    const { app, store } = await fixtures();
    await registerSessionSource(store, {
      sessionId: "ses_1",
      name: "missing",
      path: "/tmp/does-not-exist-xyz.csv",
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/internal/tools/profile_source",
      payload: { sessionID: "ses_1", source: "missing" },
    });
    expect(res.statusCode).toBe(422);
  });

  it("400s on a malformed body for both routes", async () => {
    const { app } = await fixtures();
    const a = await app.inject({
      method: "POST",
      url: "/api/internal/tools/list_sources",
      payload: {},
    });
    expect(a.statusCode).toBe(400);
    const b = await app.inject({
      method: "POST",
      url: "/api/internal/tools/profile_source",
      payload: { sessionID: "ses_1" },
    });
    expect(b.statusCode).toBe(400);
  });

  it("503s when the store is unwired for both routes", async () => {
    const app = buildServer({});
    const a = await app.inject({
      method: "POST",
      url: "/api/internal/tools/list_sources",
      payload: { sessionID: "ses_1" },
    });
    expect(a.statusCode).toBe(503);
    const b = await app.inject({
      method: "POST",
      url: "/api/internal/tools/profile_source",
      payload: { sessionID: "ses_1", source: "loans" },
    });
    expect(b.statusCode).toBe(503);
  });
});
