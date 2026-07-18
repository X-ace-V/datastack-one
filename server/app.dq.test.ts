import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "./app.js";
import { openStore, type WarehouseStore } from "./store/duckdb.js";
import { createSessionDqGate, type SessionDqGate } from "./opencode/session-dq.js";
import { createToolApprovalGate, type ToolApprovalGate } from "./opencode/tool-approvals.js";
import type { NormalizedEvent } from "./core/events.js";

/**
 * Route tests for `run_dq_check` and the FR9 publish block (V4.3). The tool runs the reviewed
 * data-quality checks against a loaded warehouse table and records the outcome on the per-session
 * DQ gate; a **failing** run blocks a later `publish_serving` for that session until a subsequent
 * run passes. We drive the real routes over a real in-memory warehouse (the `publish_serving`
 * gate auto-answers as the human), covering: a passing run publishes, a failing run refuses the
 * publish (409, no approval even opened, nothing registered), re-passing unblocks, and the error
 * branches (422 degenerate spec, 400 bad body, 503 unwired store, plus the no-gate boot behavior).
 */
describe("run_dq_check route + publish block (V4.3, FR9)", () => {
  const open: WarehouseStore[] = [];
  const tmpDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(open.splice(0).map((s) => s.close()));
    await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  // Four checks — one of each type — that all PASS against the fixture below (loan_id/opened_at
  // are non-null; branch exists; the table has rows).
  const PASS_CHECKS = [
    { name: "has rows", type: "row_count", column: null, description: "table has ≥1 row" },
    { name: "loan_id not null", type: "not_null", column: "loan_id", description: "loan_id has no NULLs" },
    { name: "branch present", type: "schema", column: "branch", description: "branch column exists" },
    { name: "opened_at fresh", type: "freshness", column: "opened_at", description: "opened_at non-null" },
  ];

  // The same four, but the not_null check targets `balance`, which has a NULL in the fixture — so
  // that one check FAILS and the aggregate run fails (blocking publish).
  const FAIL_CHECKS = [
    { name: "has rows", type: "row_count", column: null, description: "table has ≥1 row" },
    { name: "balance not null", type: "not_null", column: "balance", description: "balance has no NULLs" },
    { name: "branch present", type: "schema", column: "branch", description: "branch column exists" },
    { name: "opened_at fresh", type: "freshness", column: "opened_at", description: "opened_at non-null" },
  ];

  /**
   * A backend with a loaded `raw.source` (one NULL balance) + a `marts.report` to publish, a real
   * per-session DQ gate, and a `publish_serving` approval gate that auto-approves. Emitted SSE
   * events are captured so a test can assert whether an approval was ever opened.
   */
  async function fixtures(): Promise<{
    app: ReturnType<typeof buildServer>;
    store: WarehouseStore;
    dqGate: SessionDqGate;
    emitted: NormalizedEvent[];
  }> {
    const store = await openStore(":memory:");
    open.push(store);
    // raw.source: loan_id/branch/opened_at all non-null; balance has one NULL (the fail trap).
    await store.run(
      "CREATE OR REPLACE TABLE raw.source AS SELECT * FROM (VALUES " +
        "(1, 'north', 1000.0, DATE '2024-01-01'), " +
        "(2, 'south', NULL, DATE '2024-01-02')) AS t(loan_id, branch, balance, opened_at)",
    );
    // A marts table to publish once DQ is green.
    await store.run(
      "CREATE OR REPLACE TABLE marts.report AS " +
        "SELECT branch, count(*)::BIGINT AS n FROM raw.source GROUP BY branch",
    );
    const dqGate = createSessionDqGate();
    const servingDir = await mkdtemp(join(tmpdir(), "dq-serve-"));
    tmpDirs.push(servingDir);
    const emitted: NormalizedEvent[] = [];
    let gate: ToolApprovalGate;
    gate = createToolApprovalGate((event) => {
      emitted.push(event);
      if (event.kind === "approval") {
        const req = event;
        queueMicrotask(() => gate.reply(req.requestID, "approve"));
      }
    });
    const app = buildServer({ store, dqGate, toolApprovals: gate, servingDir });
    return { app, store, dqGate, emitted };
  }

  /** Whether a served table row exists in the registry (publish's observable side effect). */
  async function isRegistered(store: WarehouseStore, name: string): Promise<boolean> {
    const rows = await store.all("SELECT 1 FROM platform.served_tables WHERE name = $1", [name]);
    return rows.length > 0;
  }

  it("a passing DQ run reports all checks green and does not block publish", async () => {
    const { app, store, dqGate } = await fixtures();

    const dq = await app.inject({
      method: "POST",
      url: "/api/internal/tools/run_dq_check",
      payload: { sessionID: "ses_1", checks: PASS_CHECKS },
    });
    expect(dq.statusCode).toBe(200);
    const result = dq.json().result;
    expect(result.passed).toBe(true);
    expect(result.targetTable).toBe("raw.source");
    expect(result.results).toHaveLength(4);
    expect(result.results.every((r: { passed: boolean }) => r.passed)).toBe(true);
    expect(dqGate.isPublishBlocked("ses_1")).toBe(false);

    // Publish is allowed: the served endpoint is registered.
    const publish = await app.inject({
      method: "POST",
      url: "/api/internal/tools/publish_serving",
      payload: { sessionID: "ses_1", table: "report" },
    });
    expect(publish.statusCode).toBe(200);
    expect(publish.json().name).toBe("report");
    expect(await isRegistered(store, "report")).toBe(true);
  });

  it("a failing DQ run blocks a later publish (409), opening no approval and writing nothing", async () => {
    const { app, store, dqGate, emitted } = await fixtures();

    const dq = await app.inject({
      method: "POST",
      url: "/api/internal/tools/run_dq_check",
      payload: { sessionID: "ses_1", checks: FAIL_CHECKS },
    });
    expect(dq.statusCode).toBe(200);
    const result = dq.json().result;
    expect(result.passed).toBe(false);
    const failed = result.results.filter((r: { passed: boolean }) => !r.passed);
    expect(failed.map((r: { name: string }) => r.name)).toEqual(["balance not null"]);
    expect(dqGate.isPublishBlocked("ses_1")).toBe(true);

    // Publish is refused with a 409 that names the failed check(s).
    const publish = await app.inject({
      method: "POST",
      url: "/api/internal/tools/publish_serving",
      payload: { sessionID: "ses_1", table: "report" },
    });
    expect(publish.statusCode).toBe(409);
    const body = publish.json();
    expect(body.blocked).toBe(true);
    expect(body.failedChecks).toEqual(["balance not null"]);

    // The block short-circuits BEFORE the approval gate — no pill was ever surfaced, and nothing
    // was registered.
    expect(emitted.filter((e) => e.kind === "approval")).toHaveLength(0);
    expect(await isRegistered(store, "report")).toBe(false);
  });

  it("re-running DQ to green unblocks the publish", async () => {
    const { app, store, dqGate } = await fixtures();

    await app.inject({
      method: "POST",
      url: "/api/internal/tools/run_dq_check",
      payload: { sessionID: "ses_1", checks: FAIL_CHECKS },
    });
    expect(dqGate.isPublishBlocked("ses_1")).toBe(true);

    // A subsequent passing run replaces the failing one and lifts the block.
    const rerun = await app.inject({
      method: "POST",
      url: "/api/internal/tools/run_dq_check",
      payload: { sessionID: "ses_1", checks: PASS_CHECKS },
    });
    expect(rerun.json().result.passed).toBe(true);
    expect(dqGate.isPublishBlocked("ses_1")).toBe(false);

    const publish = await app.inject({
      method: "POST",
      url: "/api/internal/tools/publish_serving",
      payload: { sessionID: "ses_1", table: "report" },
    });
    expect(publish.statusCode).toBe(200);
    expect(await isRegistered(store, "report")).toBe(true);
  });

  it("a check whose column does not exist fails honestly and blocks publish", async () => {
    const { app, dqGate } = await fixtures();
    const dq = await app.inject({
      method: "POST",
      url: "/api/internal/tools/run_dq_check",
      payload: {
        sessionID: "ses_1",
        checks: [
          { name: "has rows", type: "row_count", column: null, description: "rows" },
          { name: "ghost not null", type: "not_null", column: "ghost", description: "ghost non-null" },
          { name: "branch present", type: "schema", column: "branch", description: "branch exists" },
        ],
      },
    });
    expect(dq.statusCode).toBe(200);
    const result = dq.json().result;
    expect(result.passed).toBe(false);
    const ghost = result.results.find((r: { name: string }) => r.name === "ghost not null");
    expect(ghost.passed).toBe(false);
    expect(ghost.detail).toContain("errored");
    expect(dqGate.isPublishBlocked("ses_1")).toBe(true);
  });

  it("422s a degenerate spec that does not cover ≥3 distinct check types", async () => {
    const { app } = await fixtures();
    const res = await app.inject({
      method: "POST",
      url: "/api/internal/tools/run_dq_check",
      payload: {
        sessionID: "ses_1",
        checks: [
          { name: "a", type: "not_null", column: "loan_id", description: "loan_id" },
          { name: "b", type: "not_null", column: "branch", description: "branch" },
          { name: "c", type: "not_null", column: "opened_at", description: "opened_at" },
        ],
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatch(/distinct/i);
  });

  it("422s a spec with fewer than three checks", async () => {
    const { app } = await fixtures();
    const res = await app.inject({
      method: "POST",
      url: "/api/internal/tools/run_dq_check",
      payload: {
        sessionID: "ses_1",
        checks: [{ name: "a", type: "row_count", column: null, description: "rows" }],
      },
    });
    expect(res.statusCode).toBe(422);
  });

  it("400s a malformed body (missing sessionID)", async () => {
    const { app } = await fixtures();
    const res = await app.inject({
      method: "POST",
      url: "/api/internal/tools/run_dq_check",
      payload: { checks: PASS_CHECKS },
    });
    expect(res.statusCode).toBe(400);
  });

  it("503s when the store is unwired", async () => {
    const app = buildServer({});
    const res = await app.inject({
      method: "POST",
      url: "/api/internal/tools/run_dq_check",
      payload: { sessionID: "ses_1", checks: PASS_CHECKS },
    });
    expect(res.statusCode).toBe(503);
  });

  it("without a DQ gate wired, a failing run cannot block publish (health-boot behavior)", async () => {
    // Same store + marts table, but no dqGate: run_dq_check still runs, but records nowhere, so
    // publish is not gated by it.
    const store = await openStore(":memory:");
    open.push(store);
    await store.run(
      "CREATE OR REPLACE TABLE raw.source AS SELECT * FROM (VALUES " +
        "(1, 'north', NULL, DATE '2024-01-01')) AS t(loan_id, branch, balance, opened_at)",
    );
    await store.run("CREATE OR REPLACE TABLE marts.report AS SELECT branch FROM raw.source");
    const servingDir = await mkdtemp(join(tmpdir(), "dq-serve-nogate-"));
    tmpDirs.push(servingDir);
    let gate: ToolApprovalGate;
    gate = createToolApprovalGate((event) => {
      if (event.kind === "approval") queueMicrotask(() => gate.reply(event.requestID, "approve"));
    });
    const app = buildServer({ store, toolApprovals: gate, servingDir });

    const dq = await app.inject({
      method: "POST",
      url: "/api/internal/tools/run_dq_check",
      payload: { sessionID: "ses_1", checks: FAIL_CHECKS },
    });
    expect(dq.statusCode).toBe(200);
    expect(dq.json().result.passed).toBe(false);

    const publish = await app.inject({
      method: "POST",
      url: "/api/internal/tools/publish_serving",
      payload: { sessionID: "ses_1", table: "report" },
    });
    expect(publish.statusCode).toBe(200);
  });
});
