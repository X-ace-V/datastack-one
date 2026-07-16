import type { Event, OpencodeClient, Permission } from "@opencode-ai/sdk";
import {
  ACTION_TO_RESPONSE,
  ApprovalRequestSchema,
  toApprovalResult,
  type ApprovalAction,
  type ApprovalRequest,
  type ApprovalResult,
} from "../core/approvals.js";

/**
 * OpenCode permission bridge (TASKS T1.4, PRD FR8, ARCHITECTURE §6). Captures every
 * `permission.updated` event the runtime raises for a write/execute tool into a pending
 * approvals queue, and answers a queued request by replying to the runtime — `approve`
 * → `once` (this call only), `reject` → `reject`. This is the enforcement point for
 * "approve before execute": nothing gated runs until a human resolves its request here.
 *
 * Events are fed in via {@link ApprovalGate.ingest}, driven from the run bridge's single
 * `event.subscribe()` pump (see {@link file://./bridge.ts}) so the platform reads the
 * runtime's event stream exactly once.
 */

/**
 * Minimal client surface the gate needs: the reply endpoint. Narrowing to this slice
 * keeps the gate trivially mockable in a unit test without spawning the `opencode` server.
 */
export type PermissionClient = Pick<
  OpencodeClient,
  "postSessionIdPermissionsPermissionId"
>;

/** Thrown when replying to a request that is not (or no longer) pending → HTTP 404. */
export class UnknownApprovalError extends Error {
  constructor(requestID: string) {
    super(`no pending approval for request "${requestID}"`);
    this.name = "UnknownApprovalError";
  }
}

/** Thrown when the runtime rejects the reply → HTTP 502 (the decision was not recorded). */
export class ApprovalReplyError extends Error {
  constructor(requestID: string, detail: string) {
    super(`failed to reply to approval "${requestID}": ${detail}`);
    this.name = "ApprovalReplyError";
  }
}

/** The approval gate surface consumed by the approvals route and the run bridge. */
export interface ApprovalGate {
  /**
   * Feed one raw runtime event. A `permission.updated` is captured/updated in the queue;
   * a `permission.replied` (answered here or elsewhere) drops it. Other events are ignored.
   */
  ingest(event: Event): void;
  /** All still-pending requests, oldest first, for the UI/SSE to render. */
  pending(): ApprovalRequest[];
  /** The pending request for `requestID`, or `undefined` if none is queued. */
  get(requestID: string): ApprovalRequest | undefined;
  /**
   * Resolve a pending request by replying to the runtime, then drop it from the queue.
   * @throws {UnknownApprovalError} if no such request is pending.
   * @throws {ApprovalReplyError} if the runtime rejects the reply (request stays pending).
   */
  reply(requestID: string, action: ApprovalAction): Promise<ApprovalResult>;
}

/** Map an OpenCode `Permission` (the `permission.updated` payload) to a queue entry. */
function toApprovalRequest(permission: Permission): ApprovalRequest {
  return ApprovalRequestSchema.parse({
    requestID: permission.id,
    sessionID: permission.sessionID,
    type: permission.type,
    title: permission.title,
    callID: permission.callID,
    pattern: permission.pattern,
    metadata: permission.metadata,
    createdAt: permission.time.created,
  });
}

/**
 * Create the approval gate over a permission-capable client. The gate is passive: it only
 * acts when {@link ApprovalGate.ingest} is fed events (by the run bridge) and when
 * {@link ApprovalGate.reply} is called (by the route).
 */
export function createApprovalGate(client: PermissionClient): ApprovalGate {
  // requestID → pending request. Insertion order is preserved, so pending() is oldest-first.
  const queue = new Map<string, ApprovalRequest>();

  return {
    ingest(event) {
      if (event.type === "permission.updated") {
        const request = toApprovalRequest(event.properties as Permission);
        queue.set(request.requestID, request);
        return;
      }
      if (event.type === "permission.replied") {
        const props = event.properties as { permissionID: string };
        queue.delete(props.permissionID);
      }
    },

    pending() {
      return [...queue.values()];
    },

    get(requestID) {
      return queue.get(requestID);
    },

    async reply(requestID, action) {
      const request = queue.get(requestID);
      if (!request) throw new UnknownApprovalError(requestID);

      const res = await client.postSessionIdPermissionsPermissionId({
        path: { id: request.sessionID, permissionID: requestID },
        body: { response: ACTION_TO_RESPONSE[action] },
      });
      if (res.error) {
        // Keep the request pending so a transient runtime failure can be retried.
        throw new ApprovalReplyError(requestID, JSON.stringify(res.error));
      }

      queue.delete(requestID);
      return toApprovalResult(request, action);
    },
  };
}
