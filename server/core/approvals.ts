import { z } from "zod";

/**
 * Pure approval-gate contract (PRD FR8, ARCHITECTURE §6). The OpenCode runtime raises a
 * `permission.asked` event whenever a write/execute tool needs a human decision; the
 * permission bridge ({@link file://../opencode/approvals.ts}) captures each into a pending
 * queue and lets the UI answer it via `POST /api/approvals/:requestID`. This module holds
 * the shapes + the action→response mapping — no fs/net/process — so the wire contract can
 * be unit-tested directly and reused by the route, the bridge, and the SSE stream.
 *
 * The field mapping is grounded in the **live** runtime (verified against opencode 1.18.3),
 * not the `@opencode-ai/sdk` v1 `Event` types: the running server emits the v2 permission
 * contract (`permission.asked` / `permission.replied`), whose properties differ from the v1
 * `Permission`/`permission.updated` shape the SDK's default types describe. See
 * {@link PermissionAskedProperties}.
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
 * OpenCode `permission.asked` event's properties, keeping exactly what the approval flow
 * needs: the id to reply against, the session to reply on, and the permission type + metadata
 * the UI renders so a human sees the exact SQL/DDL before approving.
 */
export const ApprovalRequestSchema = z.object({
  /** Permission id (event `properties.id`) — the `:requestID` path param used to reply. */
  requestID: z.string().min(1),
  /** Session the reply is posted against (`POST /session/:id/permissions/:permissionID`). */
  sessionID: z.string().min(1),
  /** The gated surface/tool, from `properties.permission` (e.g. `bash`, `run_transform`). */
  type: z.string().min(1),
  /** The permission's metadata — carries the exact args/SQL/DDL for the UI to render. */
  metadata: z.record(z.string(), z.unknown()),
  /** The tool call this gates (`properties.tool.callID`), when it originates from a tool. */
  callID: z.string().optional(),
  /** The patterns the permission applies to (`properties.patterns`), e.g. the command run. */
  patterns: z.array(z.string()).optional(),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

/**
 * The properties of a live `permission.asked` event (opencode v2 runtime contract, verified
 * against opencode 1.18.3 — NOT the `@opencode-ai/sdk` v1 `Permission` type, which the running
 * server does not emit). `permission` is the gated surface/tool, `metadata` carries the args
 * (e.g. `{ command }` for bash, the SQL/DDL for a write tool), and a tool-originated request
 * nests its `callID` under `tool`. There is no `title` or `time.created` in this contract.
 */
export interface PermissionAskedProperties {
  id: string;
  sessionID: string;
  permission: string;
  patterns?: string[];
  metadata: Record<string, unknown>;
  always?: string[];
  tool?: { messageID: string; callID: string };
}

/** The properties of a live `permission.replied` event (v2 runtime contract). */
export interface PermissionRepliedProperties {
  sessionID: string;
  requestID: string;
  reply: "once" | "always" | "reject";
}

/**
 * Map a live `permission.asked` event's properties to a validated {@link ApprovalRequest}.
 * Shared by the gate (which captures the pending queue) and the event bridge (which surfaces
 * the same request inline over the chat SSE stream), so both read the runtime's fields the
 * same way. Throws (via zod) on a payload missing the id/session/permission the flow needs.
 */
export function toApprovalRequest(props: PermissionAskedProperties): ApprovalRequest {
  return ApprovalRequestSchema.parse({
    requestID: props.id,
    sessionID: props.sessionID,
    type: props.permission,
    metadata: props.metadata,
    callID: props.tool?.callID,
    patterns: props.patterns,
  });
}

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
