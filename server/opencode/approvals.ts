import type { Event, OpencodeClient } from "@opencode-ai/sdk";
import {
  ACTION_TO_RESPONSE,
  toApprovalRequest,
  toApprovalResult,
  type ApprovalAction,
  type ApprovalRequest,
  type ApprovalResult,
  type PermissionAskedProperties,
  type PermissionRepliedProperties,
} from "../core/approvals.js";

/**
 * OpenCode permission bridge (TASKS V1.6, PRD FR8, ARCHITECTURE §6). Captures every
 * `permission.asked` event the runtime raises for a write/execute tool into a pending
 * approvals queue, and answers a queued request by replying to the runtime — `approve`
 * → `once` (this call only), `reject` → `reject`. This is the enforcement point for
 * "approve before execute": nothing gated runs until a human resolves its request here.
 *
 * The event names + shapes are the live opencode v2 runtime contract (`permission.asked` /
 * `permission.replied`), verified against opencode 1.18.3 — NOT the `@opencode-ai/sdk` v1
 * `Event` types, which name `permission.updated` and a `Permission` payload the running
 * server never emits. So `ingest` reads the raw event type as a string and the properties
 * via {@link PermissionAskedProperties}/{@link PermissionRepliedProperties}.
 *
 * Events are fed in via {@link ApprovalGate.ingest}, driven from the event bridge's single
 * `/global/event` pump (see {@link file://./bridge.ts}) so the platform reads one stream across
 * every folder-rooted runtime.
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
   * Feed one raw runtime event. A `permission.asked` is captured/updated in the queue;
   * a `permission.replied` (answered here or elsewhere) drops it. Other events are ignored.
   */
  ingest(event: Event, directory?: string): void;
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

/**
 * Create the approval gate over a permission-capable client. The gate is passive: it only
 * acts when {@link ApprovalGate.ingest} is fed events (by the run bridge) and when
 * {@link ApprovalGate.reply} is called (by the route).
 */
export function createApprovalGate(client: PermissionClient): ApprovalGate {
  // requestID → pending request. Insertion order is preserved, so pending() is oldest-first.
  const queue = new Map<string, { request: ApprovalRequest; directory?: string }>();

  return {
    ingest(event, directory) {
      // The live runtime emits event types outside the v1 `Event` union, so match on the raw
      // type string and read the v2 properties via the verified shapes (see the module doc).
      const raw = event as unknown as { type: string; properties: unknown };
      if (raw.type === "permission.asked") {
        const request = toApprovalRequest(raw.properties as PermissionAskedProperties);
        queue.set(request.requestID, { request, directory });
        return;
      }
      if (raw.type === "permission.replied") {
        const props = raw.properties as PermissionRepliedProperties;
        queue.delete(props.requestID);
      }
    },

    pending() {
      return [...queue.values()].map((entry) => entry.request);
    },

    get(requestID) {
      return queue.get(requestID)?.request;
    },

    async reply(requestID, action) {
      const pending = queue.get(requestID);
      if (!pending) throw new UnknownApprovalError(requestID);
      const { request, directory } = pending;

      const res = await client.postSessionIdPermissionsPermissionId({
        path: { id: request.sessionID, permissionID: requestID },
        body: { response: ACTION_TO_RESPONSE[action] },
        ...(directory ? { query: { directory } } : {}),
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
