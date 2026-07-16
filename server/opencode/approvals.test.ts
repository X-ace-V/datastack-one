import { describe, expect, it, vi } from "vitest";
import type { Event } from "@opencode-ai/sdk";
import {
  ApprovalReplyError,
  UnknownApprovalError,
  createApprovalGate,
  type PermissionClient,
} from "./approvals.js";
import { ApprovalRequestSchema } from "../core/approvals.js";

/**
 * Unit tests for the permission bridge / approval gate (T1.4, FR8). The gate is driven by
 * hand-built runtime events (no `opencode` subprocess) and a mocked reply client so we can
 * assert the *desired* behavior: a `permission.updated` becomes a schema-valid pending
 * request; approve replies `once` and reject replies `reject` against the right session;
 * a resolved request leaves the queue; an unknown id 404s and a runtime failure keeps the
 * request pending. See LOOP.md §5 — assert values/invariants, not just "it ran".
 */

/** A `permission.updated` event for `requestID` on `sessionID`, carrying `sql` metadata. */
function askedEvent(
  requestID: string,
  sessionID: string,
  overrides: Record<string, unknown> = {},
): Event {
  return {
    type: "permission.updated",
    properties: {
      id: requestID,
      type: "run_transform",
      sessionID,
      messageID: "msg_1",
      callID: "call_1",
      title: "Execute transform SQL",
      metadata: { sql: "CREATE TABLE marts.report AS SELECT 1" },
      time: { created: 1_700_000_000_000 },
      ...overrides,
    },
  } as unknown as Event;
}

/** A `permission.replied` event, as the runtime emits once a request is answered. */
function repliedEvent(requestID: string, sessionID: string): Event {
  return {
    type: "permission.replied",
    properties: { sessionID, permissionID: requestID, response: "once" },
  } as unknown as Event;
}

/** A reply client that records its calls; `fail` makes the reply return an error envelope. */
function mockClient(fail = false) {
  const calls: Array<{ path: unknown; body: unknown }> = [];
  const client = {
    postSessionIdPermissionsPermissionId: vi.fn(
      async (options: { path: unknown; body: unknown }) => {
        calls.push(options);
        return fail
          ? { data: undefined, error: { message: "runtime boom" } }
          : { data: true, error: undefined };
      },
    ),
  } as unknown as PermissionClient;
  return { client, calls };
}

describe("createApprovalGate", () => {
  it("captures a permission.updated event as a schema-valid pending request", () => {
    const { client } = mockClient();
    const gate = createApprovalGate(client);

    gate.ingest(askedEvent("perm_1", "ses_1"));

    const pending = gate.pending();
    expect(pending).toHaveLength(1);
    const req = pending[0]!;
    expect(() => ApprovalRequestSchema.parse(req)).not.toThrow();
    expect(req.requestID).toBe("perm_1");
    expect(req.sessionID).toBe("ses_1");
    expect(req.type).toBe("run_transform");
    expect(req.callID).toBe("call_1");
    expect(req.metadata).toEqual({ sql: "CREATE TABLE marts.report AS SELECT 1" });
    expect(req.createdAt).toBe(1_700_000_000_000);
    expect(gate.get("perm_1")).toEqual(req);
  });

  it("ignores non-permission events", () => {
    const { client } = mockClient();
    const gate = createApprovalGate(client);

    gate.ingest({ type: "session.idle", properties: { sessionID: "ses_1" } } as Event);

    expect(gate.pending()).toEqual([]);
  });

  it("preserves capture order so pending() is oldest-first", () => {
    const { client } = mockClient();
    const gate = createApprovalGate(client);

    gate.ingest(askedEvent("perm_a", "ses_1"));
    gate.ingest(askedEvent("perm_b", "ses_1"));

    expect(gate.pending().map((r) => r.requestID)).toEqual(["perm_a", "perm_b"]);
  });

  it("approve replies 'once' against the request's session and drops it from the queue", async () => {
    const { client, calls } = mockClient();
    const gate = createApprovalGate(client);
    gate.ingest(askedEvent("perm_1", "ses_9"));

    const result = await gate.reply("perm_1", "approve");

    expect(calls).toEqual([
      { path: { id: "ses_9", permissionID: "perm_1" }, body: { response: "once" } },
    ]);
    expect(result).toEqual({
      requestID: "perm_1",
      action: "approve",
      type: "run_transform",
      status: "approved",
    });
    expect(gate.pending()).toEqual([]);
    expect(gate.get("perm_1")).toBeUndefined();
  });

  it("reject replies 'reject' and drops the request from the queue", async () => {
    const { client, calls } = mockClient();
    const gate = createApprovalGate(client);
    gate.ingest(askedEvent("perm_2", "ses_3"));

    const result = await gate.reply("perm_2", "reject");

    expect(calls).toEqual([
      { path: { id: "ses_3", permissionID: "perm_2" }, body: { response: "reject" } },
    ]);
    expect(result.status).toBe("rejected");
    expect(gate.pending()).toEqual([]);
  });

  it("never sends 'always' — the MVP has no blanket-approve path", async () => {
    const { client, calls } = mockClient();
    const gate = createApprovalGate(client);
    gate.ingest(askedEvent("perm_1", "ses_1"));

    await gate.reply("perm_1", "approve");

    const bodies = calls.map((c) => (c.body as { response: string }).response);
    expect(bodies).not.toContain("always");
  });

  it("throws UnknownApprovalError when replying to an unqueued request", async () => {
    const { client, calls } = mockClient();
    const gate = createApprovalGate(client);

    await expect(gate.reply("nope", "approve")).rejects.toBeInstanceOf(
      UnknownApprovalError,
    );
    expect(calls).toEqual([]);
  });

  it("keeps the request pending and throws ApprovalReplyError when the runtime fails", async () => {
    const { client } = mockClient(true);
    const gate = createApprovalGate(client);
    gate.ingest(askedEvent("perm_1", "ses_1"));

    await expect(gate.reply("perm_1", "approve")).rejects.toBeInstanceOf(
      ApprovalReplyError,
    );
    // Still pending so a transient failure can be retried.
    expect(gate.get("perm_1")?.requestID).toBe("perm_1");
  });

  it("drops a request from the queue on a permission.replied event", () => {
    const { client } = mockClient();
    const gate = createApprovalGate(client);
    gate.ingest(askedEvent("perm_1", "ses_1"));
    expect(gate.pending()).toHaveLength(1);

    gate.ingest(repliedEvent("perm_1", "ses_1"));

    expect(gate.pending()).toEqual([]);
  });
});
