import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "./app.js";
import { openStore, type WarehouseStore } from "./store/duckdb.js";
import { insertSession } from "./store/sessions.js";
import { registerSessionSource } from "./store/session-sources.js";
import { createSessionDqGate } from "./opencode/session-dq.js";
import { createToolApprovalGate, type ToolApprovalGate } from "./opencode/tool-approvals.js";
import type { NormalizedEvent } from "./core/events.js";
import type { LineageEvent } from "./core/session-lineage.js";

/**
 * Route tests for the session lineage/audit trail (V4.4, FR12). Assert the trail is PERSISTED at
 * the write/approval/DQ points and read back by `GET /api/sessions/:id/lineage`:
 *  - a write flow records the approval BEFORE the tool_call (the PRD §5 "100% of writes approved"
 *    invariant — verified by reading the trail before answering the approval and finding no
 *    tool_call yet), then the executed tool_call after;
 *  - a rejected write records the rejection and a rejected tool_call, and writes nothing;
 *  - a DQ run records its pass/fail outcome;
 *  - the GET route maps 503 (no store) / 404 (unknown session) / 200 (the trail).
 */
describe("session lineage route (V4.4, FR12)", () => {
  const open: WarehouseStore[] = [];
  const tmpDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(open.splice(0).map((s) => s.close()));
    await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  const LOANS_CSV =
    "loan_id,customer_id,branch,balance,opened_at\n" +
    "1,100,north,1000.50,2024-01-01\n" +
    "2,101,south,250.00,2024-01-02\n";

  async function csvFile(contents: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "lineage-src-"));
    tmpDirs.push(dir);
    const path = join(dir, "loans.csv");
    await writeFile(path, contents);
    return path;
  }

  /**
   * A backend wired with a store, a per-session DQ gate, and a write-tool approval gate that only
   * CAPTURES emitted events (does not auto-answer) — so the test drives approvals through the real
   * `POST /api/approvals/:requestID` route, which is where an approval is persisted to lineage.
   */
  async function fixtures() {
    const store = await openStore(":memory:");
    open.push(store);
    await insertSession(store, { id: "ses_1", title: "Loan review" });
    const landingDir = await mkdtemp(join(tmpdir(), "lineage-land-"));
    const servingDir = await mkdtemp(join(tmpdir(), "lineage-serve-"));
    tmpDirs.push(landingDir, servingDir);
    const emitted: NormalizedEvent[] = [];
    const gate: ToolApprovalGate = createToolApprovalGate((e) => emitted.push(e));
    const dqGate = createSessionDqGate();
    const app = buildServer({ store, landingDir, servingDir, toolApprovals: gate, dqGate });
    return { app, store, emitted };
  }

  async function getLineage(
    app: Awaited<ReturnType<typeof fixtures>>["app"],
    sessionID = "ses_1",
  ): Promise<LineageEvent[]> {
    const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionID}/lineage` });
    expect(res.statusCode).toBe(200);
    return res.json().lineage as LineageEvent[];
  }

  /** Poll until `fn` returns a defined value (the write route surfaces its approval asynchronously). */
  async function waitFor<T>(fn: () => T | undefined, tries = 200): Promise<T> {
    for (let i = 0; i < tries; i++) {
      const value = fn();
      if (value !== undefined) return value;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("timed out waiting for a condition");
  }

  it("returns an empty trail for a fresh session", async () => {
    const { app } = await fixtures();
    expect(await getLineage(app)).toEqual([]);
  });

  it("503s when the store is unwired and 404s for an unknown session", async () => {
    const noStore = buildServer({});
    const unavailable = await noStore.inject({ method: "GET", url: "/api/sessions/x/lineage" });
    expect(unavailable.statusCode).toBe(503);

    const { app } = await fixtures();
    const unknown = await app.inject({ method: "GET", url: "/api/sessions/nope/lineage" });
    expect(unknown.statusCode).toBe(404);
  });

  it("records the approval BEFORE the executed write, and nothing before the human answers", async () => {
    const { app, store, emitted } = await fixtures();
    const path = await csvFile(LOANS_CSV);
    await registerSessionSource(store, { sessionId: "ses_1", name: "loans", path });

    // Start the write — it PAUSES on the approval gate (does not resolve yet).
    const landDone = app.inject({
      method: "POST",
      url: "/api/internal/tools/land_parquet",
      payload: { sessionID: "ses_1", source: "loans" },
    });

    // The approval surfaces inline; grab its id. Until the human answers, the trail is empty —
    // in particular there is NO land_parquet tool_call (the write has not run: PRD §5 invariant).
    const requestID = await waitFor(() => {
      const e = emitted.find((ev) => ev.kind === "approval");
      return e && "requestID" in e ? e.requestID : undefined;
    });
    const beforeAnswer = await getLineage(app);
    expect(beforeAnswer.some((e) => e.kind === "tool_call")).toBe(false);
    expect(beforeAnswer.some((e) => e.kind === "approval")).toBe(false);

    // Answer via the real approvals route → records the approval, releases the write.
    const answered = await app.inject({
      method: "POST",
      url: `/api/approvals/${requestID}`,
      payload: { action: "approve" },
    });
    expect(answered.statusCode).toBe(200);
    await landDone;

    // The trail now reads: approval (approved) THEN the executed tool_call (completed), in order.
    const trail = await getLineage(app);
    expect(trail.map((e) => e.kind)).toEqual(["approval", "tool_call"]);
    expect(trail[0]).toMatchObject({ kind: "approval", tool: "land_parquet", status: "approved" });
    expect(trail[1]).toMatchObject({
      kind: "tool_call",
      tool: "land_parquet",
      status: "completed",
    });
    // The tool_call carries the write's outcome (row count) in its detail.
    expect(trail[1]?.detail).toMatchObject({ source: "loans", rowCount: 2 });
    // seq is monotonic and gap-free.
    expect(trail.map((e) => e.seq)).toEqual([0, 1]);
  });

  it("records a rejected approval and a rejected tool_call, writing nothing", async () => {
    const { app, store, emitted } = await fixtures();
    const path = await csvFile(LOANS_CSV);
    await registerSessionSource(store, { sessionId: "ses_1", name: "loans", path });

    const landDone = app.inject({
      method: "POST",
      url: "/api/internal/tools/land_parquet",
      payload: { sessionID: "ses_1", source: "loans" },
    });
    const requestID = await waitFor(() => {
      const e = emitted.find((ev) => ev.kind === "approval");
      return e && "requestID" in e ? e.requestID : undefined;
    });
    await app.inject({
      method: "POST",
      url: `/api/approvals/${requestID}`,
      payload: { action: "reject" },
    });
    const result = await landDone;
    expect(result.json()).toEqual({ approved: false });

    const trail = await getLineage(app);
    expect(trail.map((e) => e.kind)).toEqual(["approval", "tool_call"]);
    expect(trail[0]).toMatchObject({ kind: "approval", tool: "land_parquet", status: "rejected" });
    expect(trail[1]).toMatchObject({
      kind: "tool_call",
      tool: "land_parquet",
      status: "rejected",
    });
  });

  it("records a DQ run's failing outcome in the trail", async () => {
    const { app, store } = await fixtures();
    // raw.source with a NULL balance so a not_null(balance) check fails.
    await store.run(
      "CREATE OR REPLACE TABLE raw.source AS SELECT * FROM (VALUES " +
        "(1, 'north', 1000.0, DATE '2024-01-01'), " +
        "(2, 'south', NULL, DATE '2024-01-02')) AS t(loan_id, branch, balance, opened_at)",
    );

    const dq = await app.inject({
      method: "POST",
      url: "/api/internal/tools/run_dq_check",
      payload: {
        sessionID: "ses_1",
        checks: [
          { name: "has rows", type: "row_count", column: null, description: "≥1 row" },
          { name: "balance not null", type: "not_null", column: "balance", description: "no NULLs" },
          { name: "branch present", type: "schema", column: "branch", description: "branch exists" },
          { name: "opened_at fresh", type: "freshness", column: "opened_at", description: "non-null" },
        ],
      },
    });
    expect(dq.statusCode).toBe(200);
    expect(dq.json().result.passed).toBe(false);

    const trail = await getLineage(app);
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({
      kind: "dq_result",
      tool: "run_dq_check",
      status: "failed",
    });
    const detail = trail[0]?.detail as { targetTable: string; passed: boolean; results: unknown[] };
    expect(detail.targetTable).toBe("raw.source");
    expect(detail.passed).toBe(false);
    expect(Array.isArray(detail.results)).toBe(true);
    expect(detail.results).toHaveLength(4);
  });
});
