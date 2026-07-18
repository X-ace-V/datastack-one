import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "./app.js";
import { openStore, type WarehouseStore } from "./store/duckdb.js";
import { addConnection } from "./store/connections.js";
import { listSessionLineage } from "./store/session-lineage.js";
import { createToolApprovalGate, type ToolApprovalGate } from "./opencode/tool-approvals.js";
import type { AttachResult, PostgresAttacher } from "./connections/attach.js";
import type { ApprovalAction } from "./core/approvals.js";
import type { NormalizedEvent } from "./core/events.js";

/**
 * Route tests for `attach_source` (V5.2, FR5b): the backend resolves a registered connection
 * NAME → its credentialed URL and ATTACHes it read-only, but the URL must never reach the model,
 * the approval pill, the SSE stream, or the audit trail. The real DuckDB ATTACH needs a live
 * Postgres, so these inject a STUB attacher and assert the route's contract end to end over a real
 * in-memory warehouse + a real approval gate: it pauses on approval, resolves name→URL server-side
 * (the stub receives the secret; nothing else does), records lineage, and maps the status branches.
 * The real attacher's own attach/redaction is exercised in `connections/attach.test.ts`.
 */
describe("attach_source route", () => {
  const open: WarehouseStore[] = [];

  afterEach(async () => {
    await Promise.all(open.splice(0).map((s) => s.close()));
  });

  const SECRET_URL = "postgresql://alice:hunter2@db.neon.tech/lending?sslmode=require";

  const STUB_TABLES: AttachResult = {
    tables: [
      {
        schema: "public",
        table: "loans",
        columns: [
          { name: "loan_id", type: "BIGINT" },
          { name: "amount", type: "DOUBLE" },
        ],
      },
      { schema: "public", table: "branches", columns: [{ name: "name", type: "VARCHAR" }] },
    ],
  };

  /**
   * A backend whose `attach_source` route gates on a real approval gate that auto-answers with
   * `answer` (mutable via the setter). `attachSource` is a stub that records the (alias, url) it
   * received — so a test can confirm the backend resolved name→URL — and returns fixed tables.
   * Emitted approval events are captured so a test can assert the URL never surfaces inline.
   */
  async function fixtures(attacher?: PostgresAttacher) {
    const store = await openStore(":memory:");
    open.push(store);
    const emitted: NormalizedEvent[] = [];
    const calls: { alias: string; url: string }[] = [];
    let answer: ApprovalAction = "approve";
    let gate: ToolApprovalGate;
    gate = createToolApprovalGate((event) => {
      emitted.push(event);
      if (event.kind === "approval") {
        const req = event;
        queueMicrotask(() => gate.reply(req.requestID, answer));
      }
    });
    const attachSource: PostgresAttacher =
      attacher ??
      (async (_store, input) => {
        calls.push(input);
        return STUB_TABLES;
      });
    const app = buildServer({ store, toolApprovals: gate, attachSource });
    return {
      app,
      store,
      emitted,
      calls,
      setAnswer: (a: ApprovalAction) => {
        answer = a;
      },
    };
  }

  it("attaches a registered connection and returns its name + schema, resolving name→URL", async () => {
    const { app, store, calls } = await fixtures();
    await addConnection(store, { name: "neon", type: "postgres", url: SECRET_URL });

    const res = await app.inject({
      method: "POST",
      url: "/api/internal/tools/attach_source",
      payload: { sessionID: "ses_1", name: "neon" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ name: "neon", tables: STUB_TABLES.tables });
    // The backend resolved the name to the stored secret url and handed it (only) to the attacher.
    expect(calls).toEqual([{ alias: "neon", url: SECRET_URL }]);
    // The response body never carries the credential (FR5b).
    expect(res.body).not.toContain("hunter2");
    expect(res.body).not.toContain(SECRET_URL);

    // A completed tool_call is recorded, and its detail holds NO url — only the connection name.
    const lineage = await listSessionLineage(store, "ses_1");
    const toolCall = lineage.find((e) => e.kind === "tool_call");
    expect(toolCall?.tool).toBe("attach_source");
    expect(toolCall?.status).toBe("completed");
    expect(JSON.stringify(lineage)).not.toContain("hunter2");
  });

  it("registers the attached tables so list_sources includes them by qualified name (V5.3)", async () => {
    const { app, store } = await fixtures();
    await addConnection(store, { name: "neon", type: "postgres", url: SECRET_URL });

    const attached = await app.inject({
      method: "POST",
      url: "/api/internal/tools/attach_source",
      payload: { sessionID: "ses_1", name: "neon" },
    });
    expect(attached.statusCode).toBe(200);

    // list_sources for the session now surfaces each attached table as a `postgres` source, named
    // by its qualified `<alias>.<schema>.<table>` — the identifier run_query resolves (FR5b).
    const listed = await app.inject({
      method: "POST",
      url: "/api/internal/tools/list_sources",
      payload: { sessionID: "ses_1" },
    });
    expect(listed.statusCode).toBe(200);
    const { sources } = listed.json() as {
      sources: { name: string; kind: string; rowCount: number | null }[];
    };
    expect(sources).toEqual(
      expect.arrayContaining([
        { name: "neon.public.loans", kind: "postgres", rowCount: null },
        { name: "neon.public.branches", kind: "postgres", rowCount: null },
      ]),
    );
    // The model-facing list still carries no credential.
    expect(listed.body).not.toContain("hunter2");
    expect(listed.body).not.toContain(SECRET_URL);

    // A re-attach is idempotent: the tables are upserted, not duplicated.
    await app.inject({
      method: "POST",
      url: "/api/internal/tools/attach_source",
      payload: { sessionID: "ses_1", name: "neon" },
    });
    const relisted = await app.inject({
      method: "POST",
      url: "/api/internal/tools/list_sources",
      payload: { sessionID: "ses_1" },
    });
    const relistedSources = (relisted.json() as { sources: { name: string }[] }).sources;
    expect(relistedSources.filter((s) => s.name === "neon.public.loans")).toHaveLength(1);
  });

  it("never exposes the URL in the inline approval event (SSE)", async () => {
    // Use a gate that does NOT auto-answer, so the approval stays pending while we inspect it.
    const store = await openStore(":memory:");
    open.push(store);
    await addConnection(store, { name: "neon", type: "postgres", url: SECRET_URL });
    const emitted: NormalizedEvent[] = [];
    const gate = createToolApprovalGate((event) => emitted.push(event));
    const app = buildServer({
      store,
      toolApprovals: gate,
      attachSource: async () => STUB_TABLES,
    });

    // Fire the write without awaiting — it blocks on the (unanswered) approval.
    const pending = app.inject({
      method: "POST",
      url: "/api/internal/tools/attach_source",
      payload: { sessionID: "ses_1", name: "neon" },
    });

    // Wait for the approval to surface, then assert the secret is nowhere in the emitted event.
    let approval: NormalizedEvent | undefined;
    for (let i = 0; i < 50 && !approval; i++) {
      await new Promise((r) => setTimeout(r, 5));
      approval = emitted.find((e) => e.kind === "approval");
    }
    expect(approval, "an approval event should surface").toBeDefined();
    const approvalJson = JSON.stringify(approval);
    expect(approvalJson).not.toContain("hunter2");
    expect(approvalJson).not.toContain(SECRET_URL);
    // The pill shows the connection name + type for review — never the URL.
    expect(approvalJson).toContain("neon");

    // Release the gate so the awaiting route completes, then assert the whole exchange is clean.
    const requestID = (approval as { requestID: string }).requestID;
    gate.reply(requestID, "approve");
    const res = await pending;
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("hunter2");
  });

  it("rejecting the approval attaches nothing and returns { approved: false }", async () => {
    const { app, store, calls, setAnswer } = await fixtures();
    await addConnection(store, { name: "neon", type: "postgres", url: SECRET_URL });
    setAnswer("reject");

    const res = await app.inject({
      method: "POST",
      url: "/api/internal/tools/attach_source",
      payload: { sessionID: "ses_1", name: "neon" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ approved: false });
    // The attacher was never called — nothing was attached.
    expect(calls).toHaveLength(0);
    // A rejected tool_call is audited (still no url).
    const lineage = await listSessionLineage(store, "ses_1");
    expect(lineage.find((e) => e.kind === "tool_call")?.status).toBe("rejected");
  });

  it("404s a connection name that is not registered, without opening an approval", async () => {
    const { app, emitted } = await fixtures();
    const res = await app.inject({
      method: "POST",
      url: "/api/internal/tools/attach_source",
      payload: { sessionID: "ses_1", name: "unknown" },
    });
    expect(res.statusCode).toBe(404);
    // No approval was surfaced for a connection that does not exist.
    expect(emitted.filter((e) => e.kind === "approval")).toHaveLength(0);
  });

  it("422s when the attach fails, with the error scrubbed", async () => {
    const { app, store } = await fixtures(async () => {
      // The real attacher throws a PostgresAttachError with the secret already scrubbed; model that.
      throw new Error("Could not attach <connection>: connection refused");
    });
    await addConnection(store, { name: "neon", type: "postgres", url: SECRET_URL });

    const res = await app.inject({
      method: "POST",
      url: "/api/internal/tools/attach_source",
      payload: { sessionID: "ses_1", name: "neon" },
    });
    expect(res.statusCode).toBe(422);
    expect(res.body).not.toContain("hunter2");
    // The failure is audited as an error.
    const lineage = await listSessionLineage(store, "ses_1");
    expect(lineage.find((e) => e.kind === "tool_call")?.status).toBe("error");
  });

  it("400s an invalid connection name (not a SQL identifier) before touching the store", async () => {
    const { app } = await fixtures();
    const res = await app.inject({
      method: "POST",
      url: "/api/internal/tools/attach_source",
      payload: { sessionID: "ses_1", name: "bad-name" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("503s when the store, the approval gate, or the attacher is unwired", async () => {
    const store = await openStore(":memory:");
    open.push(store);
    const gate = createToolApprovalGate(() => {});
    const payload = { sessionID: "ses_1", name: "neon" };
    const cases = [
      buildServer({ toolApprovals: gate, attachSource: async () => STUB_TABLES }), // no store
      buildServer({ store, attachSource: async () => STUB_TABLES }), // no gate
      buildServer({ store, toolApprovals: gate }), // no attacher
    ];
    for (const app of cases) {
      const res = await app.inject({
        method: "POST",
        url: "/api/internal/tools/attach_source",
        payload,
      });
      expect(res.statusCode).toBe(503);
    }
  });
});
