import { randomUUID } from "node:crypto";
import {
  ApprovalRequestSchema,
  toApprovalResult,
  type ApprovalAction,
  type ApprovalRequest,
  type ApprovalResult,
} from "../core/approvals.js";
import type { NormalizedEvent } from "../core/events.js";
import { UnknownApprovalError } from "./approvals.js";

/**
 * The write-tool approval gate (V4.1, PRD FR8/FR10). Unlike the OpenCode permission gate
 * ({@link file://./approvals.ts}, which handles built-in `bash`/`edit`/`webfetch` permissions),
 * this gate governs the **custom** data-eng write tools. OpenCode does not surface a
 * `permission.asked` for a plugin tool — a plugin's `context.ask(...)` auto-resolves in the
 * embedded runtime (verified live, see AGENTS.md) — so the pause is enforced backend-side: each
 * write tool's internal loopback route calls {@link ToolApprovalGate.request} and awaits the
 * returned promise BEFORE it executes. Nothing is written until a human answers.
 *
 * Registering a request emits an inline `approval` event onto the chat SSE stream (via the event
 * hub's `publish`), so the same {@link file://../../web/src/components/chat} approval pill renders
 * it; answering it (`POST /api/approvals/:requestID`) resolves the awaiting route and emits
 * `approval_resolved`. `approve` lets the one call run; `reject` aborts it — never a blanket
 * "always" (FR8: every write is approved once).
 */

/** Inputs to open a pending write-tool approval. */
export interface ToolApprovalInput {
  /** The chat session the write belongs to — the SSE routing key. */
  sessionID: string;
  /** The gated tool (e.g. `run_transform`) — shown on the pill and recorded on the result. */
  tool: string;
  /** The exact args/SQL/DDL the human reviews before approving (rendered on the pill). */
  metadata: Record<string, unknown>;
  /** The agent tool-call id this gates, when available (links the pill to its tool card). */
  callID?: string;
}

/** A registered pending request plus the promise its awaiting route blocks on. */
export interface PendingToolApproval {
  /** The request the UI renders + answers. */
  request: ApprovalRequest;
  /** Resolves once the request is answered — the write route awaits this. */
  decided: Promise<ApprovalResult>;
}

/** The write-tool approval gate surface consumed by the write routes and the approvals route. */
export interface ToolApprovalGate {
  /**
   * Open a pending approval for a write tool and surface it inline (SSE). Returns the request
   * plus a promise the caller awaits; the promise resolves when a human answers via
   * {@link ToolApprovalGate.reply}. The write must run only if the result is `approved`.
   */
  request(input: ToolApprovalInput): PendingToolApproval;
  /** All still-pending requests, oldest first (for live-run recovery / diagnostics). */
  pending(): ApprovalRequest[];
  /** The pending request for `requestID`, or `undefined` if none is queued here. */
  get(requestID: string): ApprovalRequest | undefined;
  /**
   * Answer a pending request: resolve its awaiting route, emit `approval_resolved`, and drop it.
   * @throws {UnknownApprovalError} if no such request is pending in this gate.
   */
  reply(requestID: string, action: ApprovalAction): ApprovalResult;
}

/** How a resolved promise is fulfilled internally. */
interface Waiter {
  request: ApprovalRequest;
  resolve: (result: ApprovalResult) => void;
}

/**
 * Create the write-tool approval gate. `emit` publishes a normalized event onto the chat stream
 * (wire it to the event hub's `publish` so approvals ride the per-session SSE fan-out); in a
 * health-only boot with no hub it can be a no-op, but then nothing surfaces inline.
 */
export function createToolApprovalGate(
  emit: (event: NormalizedEvent) => void,
): ToolApprovalGate {
  // requestID → waiter. Insertion order is preserved, so pending() is oldest-first.
  const queue = new Map<string, Waiter>();

  return {
    request(input) {
      const requestID = randomUUID();
      const request = ApprovalRequestSchema.parse({
        requestID,
        sessionID: input.sessionID,
        type: input.tool,
        metadata: input.metadata,
        ...(input.callID ? { callID: input.callID } : {}),
      });

      let resolve!: (result: ApprovalResult) => void;
      const decided = new Promise<ApprovalResult>((res) => {
        resolve = res;
      });
      queue.set(requestID, { request, resolve });

      // Surface the pending approval inline in the chat, in reading order (FR10).
      emit({ kind: "approval", ...request });

      return { request, decided };
    },

    pending() {
      return [...queue.values()].map((w) => w.request);
    },

    get(requestID) {
      return queue.get(requestID)?.request;
    },

    reply(requestID, action) {
      const waiter = queue.get(requestID);
      if (!waiter) throw new UnknownApprovalError(requestID);
      queue.delete(requestID);

      const result = toApprovalResult(waiter.request, action);
      // Clear the inline pill on every connected client, then release the awaiting write route.
      emit({
        kind: "approval_resolved",
        sessionID: waiter.request.sessionID,
        requestID,
        status: result.status,
      });
      waiter.resolve(result);
      return result;
    },
  };
}
