import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server/app.js";
import { openStore, type WarehouseStore } from "../server/store/duckdb.js";
import { SessionManager, type SessionManagerClient } from "../server/opencode/sessions.js";
import {
  createToolApprovalGate,
  type ToolApprovalGate,
} from "../server/opencode/tool-approvals.js";
import { createSessionDqGate } from "../server/opencode/session-dq.js";
import { SessionSchema, SessionWithHistorySchema } from "../server/core/sessions.js";
import type { NormalizedEvent } from "../server/core/events.js";
import type { LineageEvent } from "../server/core/session-lineage.js";

/**
 * PRD §5 acceptance test (V6.3). Drives the whole conversational-agent PLATFORM end to end over
 * the real Fastify app + a real in-memory DuckDB, and asserts the PRD §5 criteria the named flow
 * covers — *create a session → upload a CSV → ask a question → build + approve + publish → serve* —
 * as a **platform contract**, deterministically (no live model, no network):
 *
 *   1. multiple sessions, each keeping its own history;
 *   2. upload a CSV, ask a question in plain English, get a correct table back (`run_query`);
 *   4. build + publish a daily branch report — the agent's write tools each PAUSE inline for
 *      approval, run, and expose a REST endpoint;
 *   5. 100% of write tools required an inline approval BEFORE executing, verified from the
 *      persisted lineage/audit trail (each approval's `seq` precedes its tool_call's);
 *   6. the write tools surface inline approval + resolution events on the SSE seam (the tool-card
 *      stream), each carrying the tool name + status.
 *
 * The agent is model-driven at runtime, but its *capabilities* are the fixed tool set the backend
 * exposes; this test drives those exact tool/approval routes in the order a conversation would, so
 * what it proves is the platform every turn rests on. It deliberately controls the transform SQL
 * (rather than a free model's plausible-but-wrong SQL — see AGENTS.md) so the served numbers are a
 * strong, deterministic assertion.
 *
 * Criterion 3 (connect a Postgres, join a CSV to a PG table) is proven — offline + a gated live
 * layer — by {@link file://./pg-fixture.test.ts}. Criterion 7 (the flow completes on the free
 * `opencode/big-pickle`) is proven by execution and recorded in PROGRESS.md (the per-tool live
 * DoD observations of V3.1/V3.3/V4.1/V6.2 that drive each tool through a real big-pickle turn).
 */
describe("PRD §5 acceptance — conversational agent platform", () => {
  const open: WarehouseStore[] = [];
  const tmpDirs: string[] = [];
  const listening: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(listening.splice(0).map((a) => a.close()));
    await Promise.all(open.splice(0).map((s) => s.close()));
    await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  // The committed demo fixture (T6.1). Load-bearing (see AGENTS.md): thousands-separated text
  // loan_amount, exactly one exact-duplicate row (C1010), two legitimately distinct C1003 loans.
  const csvPath = fileURLToPath(new URL("../fixtures/loans_sample.csv", import.meta.url));

  /**
   * A mocked OpenCode session client (no `opencode` subprocess): `create` echoes the requested
   * title under a stable incrementing id; `prompt`/`update`/`delete`/`abort` succeed. The chat
   * routes persist the user turn to the real store through the SessionManager, so per-session
   * history is genuinely exercised.
   */
  function mockClient(): SessionManagerClient {
    let counter = 0;
    return {
      session: {
        create: vi.fn(async ({ body }: { body?: { title?: string } }) => {
          counter += 1;
          return { data: { id: `ses_${counter}`, title: body?.title ?? "" }, error: undefined };
        }),
        update: vi.fn(async () => ({ data: {}, error: undefined })),
        delete: vi.fn(async () => ({ data: true, error: undefined })),
        prompt: vi.fn(async () => ({ data: { info: {}, parts: [] }, error: undefined })),
        abort: vi.fn(async () => ({ data: true, error: undefined })),
      },
    } as never;
  }

  /**
   * A fully-wired backend: a real store, a real SessionManager (mocked runtime client), a real
   * write-tool approval gate that only CAPTURES emitted events (so approvals are answered through
   * the real `POST /api/approvals/:requestID` route — where the lineage row is written), a DQ gate,
   * and tmp dirs for uploads/landing/serving so `data/` is never touched.
   */
  async function backend() {
    const store = await openStore(":memory:");
    open.push(store);
    const uploadsDir = await mkdtemp(join(tmpdir(), "acceptance-uploads-"));
    const landingDir = await mkdtemp(join(tmpdir(), "acceptance-land-"));
    const servingDir = await mkdtemp(join(tmpdir(), "acceptance-serve-"));
    tmpDirs.push(uploadsDir, landingDir, servingDir);
    const emitted: NormalizedEvent[] = [];
    const toolApprovals: ToolApprovalGate = createToolApprovalGate((e) => emitted.push(e));
    const dqGate = createSessionDqGate();
    const sessions = new SessionManager(mockClient(), store);
    const app = buildServer({
      store,
      sessions,
      toolApprovals,
      dqGate,
      uploadsDir,
      landingDir,
      servingDir,
    });
    return { app, store, emitted };
  }

  /** Poll until `fn` returns a defined value (a write route surfaces its approval asynchronously). */
  async function waitFor<T>(fn: () => T | undefined, tries = 400): Promise<T> {
    for (let i = 0; i < tries; i++) {
      const value = fn();
      if (value !== undefined) return value;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("timed out waiting for a condition");
  }

  async function getLineage(app: FastifyInstance, sessionID: string): Promise<LineageEvent[]> {
    const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionID}/lineage` });
    expect(res.statusCode).toBe(200);
    return res.json().lineage as LineageEvent[];
  }

  async function createSession(app: FastifyInstance, title: string): Promise<string> {
    const res = await app.inject({ method: "POST", url: "/api/sessions", payload: { title } });
    expect(res.statusCode).toBe(201);
    return SessionSchema.parse(res.json()).id;
  }

  it("creates multiple sessions and switches between them, each keeping its own history (§5.1)", async () => {
    const { app } = await backend();

    const reviewId = await createSession(app, "Loan review");
    const reportId = await createSession(app, "Branch report");
    expect(reviewId).not.toBe(reportId);

    // A turn in each session — each persists to its OWN transcript.
    await app.inject({
      method: "POST",
      url: `/api/sessions/${reviewId}/chat`,
      payload: { text: "profile the loans file" },
    });
    await app.inject({
      method: "POST",
      url: `/api/sessions/${reportId}/chat`,
      payload: { text: "which branch has the most overdue loans?" },
    });

    // Switching to a session (GET :id) reloads exactly that session's history, not the other's.
    const review = SessionWithHistorySchema.parse(
      (await app.inject({ method: "GET", url: `/api/sessions/${reviewId}` })).json(),
    );
    const report = SessionWithHistorySchema.parse(
      (await app.inject({ method: "GET", url: `/api/sessions/${reportId}` })).json(),
    );
    expect(review.messages.map((m) => m.content)).toEqual(["profile the loans file"]);
    expect(report.messages.map((m) => m.content)).toEqual([
      "which branch has the most overdue loans?",
    ]);

    // The sidebar lists both sessions.
    const list = (
      (await app.inject({ method: "GET", url: "/api/sessions" })).json() as {
        sessions: { id: string }[];
      }
    ).sessions.map((s) => s.id);
    expect(list).toEqual(expect.arrayContaining([reviewId, reportId]));
    expect(list).toHaveLength(2);
  });

  it("upload CSV → NL query → build + approve + publish → serve, 100% of writes approved (§5.2/4/5/6)", async () => {
    const { app, store, emitted } = await backend();
    const sessionId = await createSession(app, "Loan review");

    // --- §5.2: upload a CSV (a real multipart upload over a socket, as the browser does) ---
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    listening.push(app);
    const csv = await readFile(csvPath);
    const form = new FormData();
    form.append("file", new Blob([csv], { type: "text/csv" }), "loans_sample.csv");
    const upload = await fetch(`${address}/api/sessions/${sessionId}/sources`, {
      method: "POST",
      body: form,
    });
    expect(upload.status).toBe(201);
    const uploaded = (await upload.json()) as { source: { name: string; rowCount: number } };
    // The whole fixture loaded into DuckDB (24 rows), registered under the filename-derived name.
    expect(uploaded.source.name).toBe("loans_sample");
    expect(uploaded.source.rowCount).toBe(24);

    // --- §5.2: ask a question in plain English → a correct table back (run_query) ---
    // (What the agent's read-only `run_query` tool posts back for the panel.)
    const query = await app.inject({
      method: "POST",
      url: "/api/internal/tools/run_query",
      payload: {
        sessionID: sessionId,
        sql: "SELECT branch, count(*)::BIGINT AS loans FROM loans_sample GROUP BY branch",
      },
    });
    expect(query.statusCode).toBe(200);
    const result = query.json().result as {
      columns: { name: string }[];
      rows: { branch: string; loans: number }[];
      truncated: boolean;
    };
    expect(result.columns.map((c) => c.name)).toEqual(["branch", "loans"]);
    const loansByBranch = new Map(result.rows.map((r) => [r.branch, r.loans]));
    // Raw counts over all 24 rows (the duplicate C1010 row is still present pre-transform).
    expect(loansByBranch.get("north")).toBe(7);
    expect(loansByBranch.get("south")).toBe(6);
    expect(loansByBranch.get("east")).toBe(6);
    expect(loansByBranch.get("west")).toBe(5);
    expect(result.truncated).toBe(false);

    // --- §5.4/5.5: build + publish the daily branch report; each write pauses for approval ---
    const answered = new Set<string>();

    /**
     * Drive one write tool the way a conversation does: it PAUSES on the approval gate; assert
     * that BEFORE the human answers there is no tool_call for it in the trail (it has not run —
     * the §5.5 invariant), then answer through the real approvals route and let the write finish.
     */
    async function approvedWrite(
      url: string,
      payload: Record<string, unknown>,
      tool: string,
    ): Promise<unknown> {
      const done = app.inject({ method: "POST", url, payload });
      const requestID = await waitFor(() => {
        const e = emitted.find(
          (ev) =>
            ev.kind === "approval" &&
            (ev as { type?: string }).type === tool &&
            !answered.has((ev as { requestID: string }).requestID),
        );
        return e ? (e as { requestID: string }).requestID : undefined;
      });
      answered.add(requestID);

      // The write has NOT executed while the approval is pending: no tool_call for it yet.
      const pending = await getLineage(app, sessionId);
      expect(
        pending.some((e) => e.kind === "tool_call" && e.tool === tool),
        `${tool} must not run before approval`,
      ).toBe(false);

      const ans = await app.inject({
        method: "POST",
        url: `/api/approvals/${requestID}`,
        payload: { action: "approve" },
      });
      expect(ans.statusCode).toBe(200);
      const res = (await done) as { statusCode: number; json: () => unknown };
      expect(res.statusCode).toBe(200);
      return res.json();
    }

    const land = (await approvedWrite(
      "/api/internal/tools/land_parquet",
      { sessionID: sessionId, source: "loans_sample", ingestionDate: "2026-07-16" },
      "land_parquet",
    )) as { dataset: string; rowCount: number };
    expect(land).toMatchObject({ dataset: "loans_sample", rowCount: 24 });

    const load = (await approvedWrite(
      "/api/internal/tools/load_warehouse",
      { sessionID: sessionId, dataset: "loans_sample" },
      "load_warehouse",
    )) as { qualifiedTable: string; rowCount: number };
    expect(load).toMatchObject({ qualifiedTable: "raw.source", rowCount: 24 });

    // The reviewed transform realizes rules.txt: drop the exact-duplicate row, bucket by
    // loan_status, and summarize per branch (active loan count + overdue balance).
    const transformSql =
      "CREATE OR REPLACE TABLE marts.daily_branch_summary AS " +
      "WITH deduped AS (SELECT DISTINCT * FROM raw.source) " +
      "SELECT branch, " +
      "count(*) FILTER (WHERE dpd_days = 0 AND balance > 0)::BIGINT AS active_loans, " +
      "COALESCE(sum(balance) FILTER (WHERE dpd_days > 0), 0)::DOUBLE AS overdue_amount " +
      "FROM deduped GROUP BY branch";
    const transform = (await approvedWrite(
      "/api/internal/tools/run_transform",
      { sessionID: sessionId, sql: transformSql, targetTable: "daily_branch_summary" },
      "run_transform",
    )) as { qualifiedTable: string; rowCount: number };
    expect(transform).toMatchObject({ qualifiedTable: "marts.daily_branch_summary", rowCount: 4 });

    const publish = (await approvedWrite(
      "/api/internal/tools/publish_serving",
      { sessionID: sessionId, table: "daily_branch_summary" },
      "publish_serving",
    )) as { name: string; endpoint: string; csvEndpoint: string; rowCount: number };
    expect(publish).toMatchObject({
      name: "daily_branch_summary",
      endpoint: "/api/serve/daily_branch_summary",
      csvEndpoint: "/api/serve/daily_branch_summary.csv",
      rowCount: 4,
    });

    // --- §5.4: the published report is a live REST endpoint (JSON + CSV) with the right values ---
    const serveJson = await app.inject({ method: "GET", url: publish.endpoint });
    expect(serveJson.statusCode).toBe(200);
    const served = serveJson.json() as {
      rowCount: number;
      rows: { branch: string; active_loans: number; overdue_amount: number }[];
    };
    expect(served.rowCount).toBe(4);
    const byBranch = new Map(served.rows.map((r) => [r.branch, r]));
    // Deterministic report values (duplicate row dropped; active = dpd 0 & balance > 0;
    // overdue_amount = balance of dpd > 0 loans).
    expect(byBranch.get("north")).toMatchObject({ active_loans: 4, overdue_amount: 12900 });
    expect(byBranch.get("south")).toMatchObject({ active_loans: 3, overdue_amount: 7750.25 });
    expect(byBranch.get("east")).toMatchObject({ active_loans: 2, overdue_amount: 60500.75 });
    expect(byBranch.get("west")).toMatchObject({ active_loans: 1, overdue_amount: 36350 });

    const serveCsv = await app.inject({ method: "GET", url: publish.csvEndpoint });
    expect(serveCsv.statusCode).toBe(200);
    expect(serveCsv.headers["content-type"]).toBe("text/csv; charset=utf-8");
    const csvLines = serveCsv.body.split("\n").filter(Boolean);
    expect(csvLines[0]).toBe("branch,active_loans,overdue_amount");
    expect(csvLines).toHaveLength(5); // header + 4 branches

    // --- §5.5: 100% of write tools required an inline approval BEFORE executing (audit trail) ---
    const trail = await getLineage(app, sessionId);
    const writeTools = ["land_parquet", "load_warehouse", "run_transform", "publish_serving"];
    const toolCalls = trail.filter((e) => e.kind === "tool_call");
    const approvals = trail.filter((e) => e.kind === "approval");
    // Every write ran, and every write ran as an *approved* call.
    expect(toolCalls.map((e) => e.tool)).toEqual(writeTools);
    expect(toolCalls.every((e) => e.status === "completed")).toBe(true);
    // One approval per write, each APPROVED, and each approval's seq precedes its tool_call's.
    expect(approvals).toHaveLength(writeTools.length);
    for (const tool of writeTools) {
      const approval = approvals.find((e) => e.tool === tool);
      const call = toolCalls.find((e) => e.tool === tool);
      expect(approval?.status).toBe("approved");
      expect(approval && call && approval.seq < call.seq, `${tool} approved before it ran`).toBe(
        true,
      );
    }

    // --- §5.6: the write tools surfaced inline approval + resolution events on the SSE seam ---
    const approvalEvents = emitted.filter((e) => e.kind === "approval");
    expect(approvalEvents.map((e) => (e as { type: string }).type)).toEqual(writeTools);
    expect(emitted.filter((e) => e.kind === "approval_resolved")).toHaveLength(writeTools.length);

    // The registry keyed the endpoint under this session's namespace.
    const registered = await store.all(
      "SELECT project_id FROM platform.served_tables WHERE name = $1",
      ["daily_branch_summary"],
    );
    expect(String(registered[0]?.project_id)).toBe(sessionId);
  });
});
