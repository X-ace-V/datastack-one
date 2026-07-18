import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "./app.js";
import { openStore, type WarehouseStore } from "./store/duckdb.js";
import { registerSessionSource } from "./store/session-sources.js";
import { createToolApprovalGate, type ToolApprovalGate } from "./opencode/tool-approvals.js";
import type { ApprovalAction } from "./core/approvals.js";
import type { NormalizedEvent } from "./core/events.js";

/**
 * Route tests for the write-tool loopback (V4.1, FR8): the backend half of `land_parquet`,
 * `load_warehouse`, `run_transform` and `publish_serving`. Each route PAUSES on the write-tool
 * approval gate before executing (OpenCode does not gate plugin tools). The gate here auto-answers
 * each pending approval — modelling the human — so we prove the routes surface an approval AND do
 * the REAL data-plane work end to end when allowed (land → load → transform → publish over a real
 * in-memory warehouse), refuse to write on rejection, and map the error branches (404/422/400/503).
 */
describe("internal write-tool routes", () => {
  const open: WarehouseStore[] = [];
  const tmpDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(open.splice(0).map((s) => s.close()));
    await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  const LOANS_CSV =
    "loan_id,customer_id,branch,balance,opened_at\n" +
    "1,100,north,1000.50,2024-01-01\n" +
    "2,101,south,,2024-01-02\n" +
    "3,100,north,750.25,2024-02-15\n" +
    "4,102,west,500.00,2024-03-10\n";

  async function csvFile(name: string, contents: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "internal-writes-src-"));
    tmpDirs.push(dir);
    const path = join(dir, name);
    await writeFile(path, contents);
    return path;
  }

  /**
   * A backend whose write routes gate on a real approval gate that auto-answers with `answer`
   * (mutable via the returned setter). Emitted approval events are captured so a test can assert
   * the inline surfacing.
   */
  async function fixtures() {
    const store = await openStore(":memory:");
    open.push(store);
    const landingDir = await mkdtemp(join(tmpdir(), "internal-writes-land-"));
    const servingDir = await mkdtemp(join(tmpdir(), "internal-writes-serve-"));
    tmpDirs.push(landingDir, servingDir);
    const emitted: NormalizedEvent[] = [];
    let answer: ApprovalAction = "approve";
    let gate: ToolApprovalGate;
    gate = createToolApprovalGate((event) => {
      emitted.push(event);
      if (event.kind === "approval") {
        const req = event;
        queueMicrotask(() => gate.reply(req.requestID, answer));
      }
    });
    const app = buildServer({ store, landingDir, servingDir, toolApprovals: gate });
    return {
      app,
      store,
      landingDir,
      servingDir,
      emitted,
      setAnswer: (a: ApprovalAction) => {
        answer = a;
      },
    };
  }

  it("lands → loads → transforms → publishes a source end to end", async () => {
    const { app, store, landingDir, emitted } = await fixtures();
    const path = await csvFile("loans.csv", LOANS_CSV);
    await registerSessionSource(store, { sessionId: "ses_1", name: "loans", path });

    // land_parquet: the landed dataset + rows come back, and no on-disk path is echoed (FR5b).
    const land = await app.inject({
      method: "POST",
      url: "/api/internal/tools/land_parquet",
      payload: { sessionID: "ses_1", source: "loans", ingestionDate: "2024-05-01" },
    });
    expect(land.statusCode).toBe(200);
    const landBody = land.json();
    expect(landBody).toEqual({ dataset: "loans", ingestionDate: "2024-05-01", rowCount: 4 });
    expect(land.body).not.toContain(landingDir);

    // load_warehouse: the landed dataset loads into raw.source (the default target).
    const load = await app.inject({
      method: "POST",
      url: "/api/internal/tools/load_warehouse",
      payload: { sessionID: "ses_1", dataset: "loans" },
    });
    expect(load.statusCode).toBe(200);
    expect(load.json()).toEqual({
      qualifiedTable: "raw.source",
      schema: "raw",
      table: "source",
      rowCount: 4,
    });

    // run_transform: the reviewed SQL builds a marts table; the row count is read back.
    const transform = await app.inject({
      method: "POST",
      url: "/api/internal/tools/run_transform",
      payload: {
        sessionID: "ses_1",
        sql:
          "CREATE OR REPLACE TABLE marts.branch_totals AS " +
          "SELECT branch, count(*)::BIGINT AS n FROM raw.source GROUP BY branch",
        targetTable: "branch_totals",
      },
    });
    expect(transform.statusCode).toBe(200);
    expect(transform.json()).toEqual({
      qualifiedTable: "marts.branch_totals",
      table: "branch_totals",
      rowCount: 3,
    });

    // publish_serving: exports + registers the served endpoint.
    const publish = await app.inject({
      method: "POST",
      url: "/api/internal/tools/publish_serving",
      payload: { sessionID: "ses_1", table: "branch_totals" },
    });
    expect(publish.statusCode).toBe(200);
    const pub = publish.json();
    expect(pub.name).toBe("branch_totals");
    expect(pub.rowCount).toBe(3);
    expect(pub.endpoint).toBe("/api/serve/branch_totals");
    expect(pub.csvEndpoint).toBe("/api/serve/branch_totals.csv");

    // The registry row landed under the session's namespace (project_id = sessionID in v2).
    const registered = await store.all(
      "SELECT project_id, table_name, row_count FROM platform.served_tables WHERE name = $1",
      ["branch_totals"],
    );
    expect(registered).toHaveLength(1);
    expect(String(registered[0]?.project_id)).toBe("ses_1");

    // Each of the four writes surfaced an inline approval (SSE) that a human answered (FR8/FR10).
    const approvals = emitted.filter((e) => e.kind === "approval");
    expect(approvals.map((a) => (a as { type: string }).type)).toEqual([
      "land_parquet",
      "load_warehouse",
      "run_transform",
      "publish_serving",
    ]);
    expect(emitted.filter((e) => e.kind === "approval_resolved")).toHaveLength(4);
  });

  it("rejecting the approval performs no write and returns { approved: false }", async () => {
    const { app, store, setAnswer } = await fixtures();
    const path = await csvFile("loans.csv", LOANS_CSV);
    await registerSessionSource(store, { sessionId: "ses_1", name: "loans", path });
    setAnswer("reject");

    const land = await app.inject({
      method: "POST",
      url: "/api/internal/tools/land_parquet",
      payload: { sessionID: "ses_1", source: "loans" },
    });
    expect(land.statusCode).toBe(200);
    expect(land.json()).toEqual({ approved: false });

    const transform = await app.inject({
      method: "POST",
      url: "/api/internal/tools/run_transform",
      payload: {
        sessionID: "ses_1",
        sql: "CREATE OR REPLACE TABLE marts.rejected AS SELECT 1 AS a",
        targetTable: "rejected",
      },
    });
    expect(transform.statusCode).toBe(200);
    expect(transform.json()).toEqual({ approved: false });

    // The reject wrote nothing: no landed dataset, and marts.rejected was never created.
    const landed = await store.all(
      "SELECT 1 FROM information_schema.tables WHERE table_schema = 'marts' AND table_name = 'rejected'",
    );
    expect(landed).toHaveLength(0);
  });

  it("503s when the approval gate is unwired", async () => {
    const store = await openStore(":memory:");
    open.push(store);
    const app = buildServer({ store }); // store present, but no toolApprovals gate
    const res = await app.inject({
      method: "POST",
      url: "/api/internal/tools/run_transform",
      payload: { sessionID: "s", sql: "SELECT 1", targetTable: "x" },
    });
    expect(res.statusCode).toBe(503);
  });

  it("land_parquet 404s an unknown source, without writing", async () => {
    const { app, store } = await fixtures();
    await registerSessionSource(store, {
      sessionId: "ses_other",
      name: "loans",
      path: await csvFile("loans.csv", LOANS_CSV),
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/internal/tools/land_parquet",
      payload: { sessionID: "ses_1", source: "loans" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("load_warehouse 422s a dataset that was never landed", async () => {
    const { app } = await fixtures();
    const res = await app.inject({
      method: "POST",
      url: "/api/internal/tools/load_warehouse",
      payload: { sessionID: "ses_1", dataset: "never_landed" },
    });
    expect(res.statusCode).toBe(422);
  });

  it("run_transform 422s SQL that fails (unknown table) so the agent can revise", async () => {
    const { app } = await fixtures();
    const res = await app.inject({
      method: "POST",
      url: "/api/internal/tools/run_transform",
      payload: {
        sessionID: "ses_1",
        sql: "CREATE OR REPLACE TABLE marts.x AS SELECT * FROM raw.does_not_exist",
        targetTable: "x",
      },
    });
    expect(res.statusCode).toBe(422);
  });

  it("publish_serving 422s when the marts table does not exist", async () => {
    const { app } = await fixtures();
    const res = await app.inject({
      method: "POST",
      url: "/api/internal/tools/publish_serving",
      payload: { sessionID: "ses_1", table: "missing_marts" },
    });
    expect(res.statusCode).toBe(422);
  });

  it("400s a malformed body on every write route", async () => {
    const { app } = await fixtures();
    for (const url of [
      "/api/internal/tools/land_parquet",
      "/api/internal/tools/load_warehouse",
      "/api/internal/tools/run_transform",
      "/api/internal/tools/publish_serving",
    ]) {
      const res = await app.inject({ method: "POST", url, payload: { sessionID: "ses_1" } });
      expect(res.statusCode, `${url} should 400 a body missing its required fields`).toBe(400);
    }
  });

  it("503s when the store is unwired on every write route", async () => {
    const app = buildServer({});
    const cases: [string, Record<string, unknown>][] = [
      ["/api/internal/tools/land_parquet", { sessionID: "s", source: "x" }],
      ["/api/internal/tools/load_warehouse", { sessionID: "s", dataset: "x" }],
      ["/api/internal/tools/run_transform", { sessionID: "s", sql: "SELECT 1", targetTable: "x" }],
      ["/api/internal/tools/publish_serving", { sessionID: "s", table: "x" }],
    ];
    for (const [url, payload] of cases) {
      const res = await app.inject({ method: "POST", url, payload });
      expect(res.statusCode, `${url} should 503 when unwired`).toBe(503);
    }
  });
});
