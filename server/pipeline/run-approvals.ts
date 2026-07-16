import type { ApprovalAction } from "../core/approvals.js";
import type { RunApprovalRequest } from "../core/run.js";

/**
 * The deterministic pipeline's approval-pause gate (PRD FR8, ARCHITECTURE §6). Unlike the
 * OpenCode permission gate ({@link file://../opencode/approvals.ts}, T1.4) — which answers the
 * agent runtime's own `permission.updated` events — this gate backs the scripted runner
 * ({@link file://./runner.ts}): before a gated stage runs, the runner `await`s
 * {@link RunApprovalGate.request}, which parks a pending promise until a human answers it via
 * `POST /api/runs/:runId/approvals/:requestID` → {@link RunApprovalGate.resolve}. This is the
 * enforcement point for "approve before execute" in the deterministic pipeline: nothing gated
 * runs until a human resolves its request here. Pure control-flow — no fs/net — so it is unit
 * testable without a runtime.
 */

/** Thrown when resolving a request that is not (or no longer) pending → HTTP 404. */
export class UnknownRunApprovalError extends Error {
  constructor(requestID: string) {
    super(`no pending run approval for request "${requestID}"`);
    this.name = "UnknownRunApprovalError";
  }
}

/** The gate surface consumed by the runner (request) and the approvals route (resolve/pending). */
export interface RunApprovalGate {
  /**
   * Park a gated stage until a human answers. Returns a promise that resolves to the human's
   * {@link ApprovalAction} once {@link RunApprovalGate.resolve} is called for `request.requestID`.
   */
  request(request: RunApprovalRequest): Promise<ApprovalAction>;
  /**
   * Answer a pending request, unblocking the runner and dropping it from the queue.
   * @throws {UnknownRunApprovalError} if no such request is pending.
   */
  resolve(requestID: string, action: ApprovalAction): RunApprovalRequest;
  /** All still-pending requests (optionally scoped to one run), oldest first. */
  pending(runId?: string): RunApprovalRequest[];
  /** The pending request for `requestID`, or `undefined` if none is queued. */
  get(requestID: string): RunApprovalRequest | undefined;
}

interface PendingEntry {
  request: RunApprovalRequest;
  settle: (action: ApprovalAction) => void;
}

/**
 * Create an in-memory run approval gate. Passive: it only acts when the runner calls
 * {@link RunApprovalGate.request} (parking a stage) and when the route calls
 * {@link RunApprovalGate.resolve} (a human's decision).
 */
export function createRunApprovalGate(): RunApprovalGate {
  // requestID → pending entry. Insertion order is preserved, so pending() is oldest-first.
  const queue = new Map<string, PendingEntry>();

  return {
    request(request) {
      return new Promise<ApprovalAction>((resolve) => {
        queue.set(request.requestID, { request, settle: resolve });
      });
    },

    resolve(requestID, action) {
      const entry = queue.get(requestID);
      if (!entry) throw new UnknownRunApprovalError(requestID);
      queue.delete(requestID);
      entry.settle(action);
      return entry.request;
    },

    pending(runId) {
      const all = [...queue.values()].map((entry) => entry.request);
      return runId ? all.filter((request) => request.runId === runId) : all;
    },

    get(requestID) {
      return queue.get(requestID)?.request;
    },
  };
}
