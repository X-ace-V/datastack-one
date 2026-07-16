import { z } from "zod";

/**
 * Pure approval-gate contract (PRD FR8, ARCHITECTURE §6). The OpenCode runtime raises a
 * `permission.updated` event whenever a write/execute tool needs a human decision; the
 * permission bridge ({@link file://../opencode/approvals.ts}) captures each into a pending
 * queue and lets the UI answer it via `POST /api/approvals/:requestID`. This module holds
 * the shapes + the action→response mapping — no fs/net/process — so the wire contract can
 * be unit-tested directly and reused by the route, the bridge, and (later) the SSE stream.
 */

/**
 * The decisions the MVP exposes to a human. We deliberately omit OpenCode's third reply
 * value `"always"`: PRD FR8 requires an explicit approval for **every** execution, and a
 * blanket "always" would let later calls run unapproved. Approve gates one call only.
 */
export const APPROVAL_ACTIONS = ["approve", "reject"] as const;
export type ApprovalAction = (typeof APPROVAL_ACTIONS)[number];

/** Request body for `POST /api/approvals/:requestID`. */
export const ApprovalDecisionSchema = z.object({
  /** Human decision on the pending permission request. */
  action: z.enum(APPROVAL_ACTIONS),
});
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

/**
 * OpenCode permission-reply responses. `"once"` approves this single call (never a
 * blanket "always"); `"reject"` denies it. This is the exact set the SDK's reply endpoint
 * accepts minus the intentionally-withheld `"always"`.
 */
export type PermissionResponse = "once" | "reject";

/** Map a UI-facing action to the OpenCode reply response sent to the runtime. */
export const ACTION_TO_RESPONSE: Record<ApprovalAction, PermissionResponse> = {
  approve: "once",
  reject: "reject",
};

/**
 * A captured, still-pending permission request awaiting a human decision. Derived from an
 * OpenCode `permission.updated` event's `Permission` properties, keeping exactly what the
 * approval flow needs: the id to reply against, the session to reply on, and the
 * type/title/metadata the UI renders so a human sees the exact SQL/DDL before approving.
 */
export const ApprovalRequestSchema = z.object({
  /** Permission id — the `:requestID` path param used to reply. */
  requestID: z.string().min(1),
  /** Session the reply is posted against (`POST /session/:id/permissions/:permissionID`). */
  sessionID: z.string().min(1),
  /** Permission type (e.g. the tool/surface being gated), for display + routing. */
  type: z.string().min(1),
  /** Human-readable summary shown in the approval modal. */
  title: z.string(),
  /** The tool call this gates, when the permission originates from a tool. */
  callID: z.string().optional(),
  /** Optional glob/pattern the permission applies to. */
  pattern: z.union([z.string(), z.array(z.string())]).optional(),
  /** The permission's metadata — carries the exact args/SQL/DDL for the UI to render. */
  metadata: z.record(z.string(), z.unknown()),
  /** Creation timestamp (epoch ms) from the event's `time.created`. */
  createdAt: z.number().nonnegative(),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

/**
 * The audit record returned once a pending request is resolved: the request that was
 * answered, the action taken, and the resulting status the UI shows.
 */
export const ApprovalResultSchema = z.object({
  /** The permission id that was answered. */
  requestID: z.string().min(1),
  /** The action a human took. */
  action: z.enum(APPROVAL_ACTIONS),
  /** The permission type that was gated. */
  type: z.string().min(1),
  /** Terminal status: an approval was recorded, or the step was rejected. */
  status: z.enum(["approved", "rejected"]),
});
export type ApprovalResult = z.infer<typeof ApprovalResultSchema>;

/** Build the UI-facing result for a resolved approval. */
export function toApprovalResult(
  request: ApprovalRequest,
  action: ApprovalAction,
): ApprovalResult {
  return {
    requestID: request.requestID,
    action,
    type: request.type,
    status: action === "approve" ? "approved" : "rejected",
  };
}
