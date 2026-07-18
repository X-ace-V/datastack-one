import { describe, it, expect } from "vitest";
import { buildServer } from "../server/app.js";
import { createApprovalGate } from "../server/opencode/approvals.js";
import { createToolApprovalGate } from "../server/opencode/tool-approvals.js";
import type { PermissionClient } from "../server/opencode/approvals.js";
import type { Event } from "@opencode-ai/sdk";

/**
 * Route-level tests for `POST /api/approvals/:requestID` (T1.4 / FR8). These exercise the
 * real Fastify wiring via `app.inject`: an approve/reject flows through the route to the
 * gate and back to the mocked runtime, an invalid body is rejected, an unknown request
 * 404s, a runtime failure surfaces as 502, and an unwired gate reports 503 honestly. The
 * gate's queue/reply logic itself is covered by server/opencode/approvals.test.ts.
 */

/** A reply client that records calls; `fail` returns an error envelope from the runtime. */
function mockClient(fail = false) {
  const calls: Array<{ path: unknown; body: unknown }> = [];
  const client = {
    postSessionIdPermissionsPermissionId: async (options: {
      path: unknown;
      body: unknown;
    }) => {
      calls.push(options);
      return fail
        ? { data: undefined, error: { message: "runtime boom" } }
        : { data: true, error: undefined };
    },
  } as unknown as PermissionClient;
  return { client, calls };
}

/** A `permission.asked` event (live v2 runtime shape) the gate captures into its queue. */
function askedEvent(requestID: string, sessionID: string): Event {
  return {
    type: "permission.asked",
    properties: {
      id: requestID,
      sessionID,
      permission: "run_transform",
      patterns: ["marts.report"],
      metadata: { sql: "SELECT 1" },
      always: [],
      tool: { messageID: "msg_1", callID: "call_1" },
    },
  } as unknown as Event;
}

/** Build an app whose approval gate has one pending request captured. */
function appWithPending(fail = false) {
  const { client, calls } = mockClient(fail);
  const gate = createApprovalGate(client);
  gate.ingest(askedEvent("perm_1", "ses_9"));
  return { app: buildServer({ approvals: gate }), calls };
}

describe("POST /api/approvals/:requestID", () => {
  it("approves a pending request: 200, records the reply, drains the queue", async () => {
    const { app, calls } = appWithPending();

    const res = await app.inject({
      method: "POST",
      url: "/api/approvals/perm_1",
      payload: { action: "approve" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      requestID: "perm_1",
      action: "approve",
      type: "run_transform",
      status: "approved",
    });
    expect(calls).toEqual([
      { path: { id: "ses_9", permissionID: "perm_1" }, body: { response: "once" } },
    ]);
    await app.close();
  });

  it("rejects a pending request: 200 with rejected status and a 'reject' reply", async () => {
    const { app, calls } = appWithPending();

    const res = await app.inject({
      method: "POST",
      url: "/api/approvals/perm_1",
      payload: { action: "reject" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("rejected");
    expect(calls[0]!.body).toEqual({ response: "reject" });
    await app.close();
  });

  it("returns 400 for an invalid action", async () => {
    const { app } = appWithPending();

    const res = await app.inject({
      method: "POST",
      url: "/api/approvals/perm_1",
      payload: { action: "always" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid approval decision");
    await app.close();
  });

  it("returns 404 for an unknown request id", async () => {
    const { app } = appWithPending();

    const res = await app.inject({
      method: "POST",
      url: "/api/approvals/does-not-exist",
      payload: { action: "approve" },
    });

    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("returns 502 when the runtime rejects the reply", async () => {
    const { app } = appWithPending(true);

    const res = await app.inject({
      method: "POST",
      url: "/api/approvals/perm_1",
      payload: { action: "approve" },
    });

    expect(res.statusCode).toBe(502);
    await app.close();
  });

  it("returns 503 when the approval gate is not wired", async () => {
    const app = buildServer();

    const res = await app.inject({
      method: "POST",
      url: "/api/approvals/perm_1",
      payload: { action: "approve" },
    });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "approval gate unavailable" });
    await app.close();
  });
});

/**
 * The same route answers the WRITE-tool gate (V4.1): custom write tools are gated backend-side,
 * so answering here must resolve the awaiting write route and drain the tool gate.
 */
describe("POST /api/approvals/:requestID (write-tool gate)", () => {
  it("approves a pending write-tool request: 200, resolves the awaiting route, drains", async () => {
    const gate = createToolApprovalGate(() => {});
    const app = buildServer({ toolApprovals: gate });
    const { request, decided } = gate.request({
      sessionID: "ses_1",
      tool: "run_transform",
      metadata: { sql: "SELECT 1", targetTable: "x" },
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/approvals/${request.requestID}`,
      payload: { action: "approve" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ type: "run_transform", status: "approved" });
    // The route that opened this approval unblocks with the same decision.
    await expect(decided).resolves.toMatchObject({ status: "approved" });
    expect(gate.get(request.requestID)).toBeUndefined();
    await app.close();
  });

  it("rejects a pending write-tool request and releases the route as rejected", async () => {
    const gate = createToolApprovalGate(() => {});
    const app = buildServer({ toolApprovals: gate });
    const { request, decided } = gate.request({
      sessionID: "ses_1",
      tool: "publish_serving",
      metadata: { table: "report" },
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/approvals/${request.requestID}`,
      payload: { action: "reject" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("rejected");
    await expect(decided).resolves.toMatchObject({ status: "rejected" });
    await app.close();
  });

  it("prefers the tool gate but falls back to the OpenCode gate for a built-in permission", async () => {
    // Only the OpenCode gate holds this id; the tool gate is present but empty.
    const { client } = mockClient();
    const openCodeGate = createApprovalGate(client);
    openCodeGate.ingest(askedEvent("perm_bash", "ses_9"));
    const app = buildServer({
      toolApprovals: createToolApprovalGate(() => {}),
      approvals: openCodeGate,
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/approvals/perm_bash",
      payload: { action: "approve" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ requestID: "perm_bash", status: "approved" });
    await app.close();
  });
});
