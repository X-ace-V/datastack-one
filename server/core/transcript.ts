import { z } from "zod";
import { NORMALIZED_TOOL_STATUSES, type NormalizedEvent } from "./events.js";

/**
 * Pure transcript-persistence contract (TASKS V6.2, PRD FR1). Reopening a session must
 * reconstruct not just its plain text but its **tool-block history** — the ordered text,
 * reasoning, and tool cards that streamed during each assistant turn (ARCHITECTURE §4). To
 * survive a restart or a fresh browser, that rendered shape is persisted into the `platform`
 * schema, so this module defines the durable **block** representation and the pure mapping from
 * a live {@link NormalizedEvent} to one persisted block.
 *
 * The stateful accumulate-and-write side lives in {@link file://../opencode/transcript.ts}
 * (the persister, fed off the event bridge); the store round-trip lives in
 * {@link file://../store/sessions.ts}. Kept pure — no fs/net/process — so both the block shape
 * and the event→block mapping are unit-testable in isolation and reused by the store's zod
 * validation on read-back.
 *
 * Approval pills are deliberately NOT persisted as blocks: a reopened turn is already resolved,
 * so the tool card's terminal status (`completed`/`error`) carries the outcome, and the
 * ask/answer audit lives in `platform.lineage` (V4.4). This is exactly "message + tool-block
 * history" — text, reasoning, and tool calls, in reading order.
 */

/** A streamed chunk of assistant answer text, keyed by its message part id. */
export const PersistedTextBlockSchema = z.object({
  kind: z.literal("text"),
  partID: z.string().min(1),
  text: z.string(),
});

/** A streamed chunk of the agent's reasoning, rendered separately from the answer. */
export const PersistedReasoningBlockSchema = z.object({
  kind: z.literal("reasoning"),
  partID: z.string().min(1),
  text: z.string(),
});

/**
 * A tool call as it settled at turn end — its terminal status plus the args/result the tool
 * card renders. A source is referenced by name, never a URL (FR5b), so nothing secret ever
 * reaches `input`/`metadata`, and thus never this persisted row.
 */
export const PersistedToolBlockSchema = z.object({
  kind: z.literal("tool"),
  /** The tool-call id — the stable key a block was upserted by as its status streamed. */
  callID: z.string().min(1),
  /** The tool that ran, e.g. `run_query` / `run_transform`. */
  tool: z.string().min(1),
  /** Where the call ended up (usually `completed`/`error` once the turn is idle). */
  status: z.enum(NORMALIZED_TOOL_STATUSES),
  /** The model-produced arguments. */
  input: z.record(z.string(), z.unknown()).optional(),
  /** The tool's textual result, once completed. */
  output: z.string().optional(),
  /** The failure detail, if it errored. */
  error: z.string().optional(),
  /** A short human-readable title the runtime attached. */
  title: z.string().optional(),
  /** Structured data-panel payload (e.g. `run_query`'s `{ result }`); never a path/credential. */
  metadata: z.record(z.string(), z.unknown()).optional(),
});

/**
 * One rendered block of a persisted assistant turn, in reading order — the durable mirror of
 * the web store's `InlineBlock` (minus the transient `approval` pill). A discriminated union on
 * `kind` so the read-back can validate it and the UI can switch on it exhaustively.
 */
export const PersistedBlockSchema = z.discriminatedUnion("kind", [
  PersistedTextBlockSchema,
  PersistedReasoningBlockSchema,
  PersistedToolBlockSchema,
]);
export type PersistedBlock = z.infer<typeof PersistedBlockSchema>;

/** An ordered array of persisted blocks — the JSON stored on an assistant `platform.messages` row. */
export const PersistedBlocksSchema = z.array(PersistedBlockSchema);

/**
 * The stable accumulation key for a normalized event's block. Text/reasoning parts are keyed by
 * their `partID` (the runtime resends a part's full accumulated text, so a later event replaces
 * the earlier block in place); a tool call is keyed by its `callID` (stable across its
 * pending→running→terminal updates). The `text:`/`reasoning:`/`tool:` prefix keeps the three
 * namespaces from colliding.
 */
export function blockKey(event: NormalizedEvent): string | null {
  switch (event.kind) {
    case "text":
      return `text:${event.partID}`;
    case "reasoning":
      return `reasoning:${event.partID}`;
    case "tool":
      return `tool:${event.callID}`;
    default:
      return null;
  }
}

/**
 * Map one normalized chat event to the persisted block it contributes, or `null` if the event
 * is not durable transcript content (idle/error/approval/approval_resolved). Total and pure:
 * this is the mapping the persister applies to each streamed event and the unit tests assert.
 */
export function toPersistedBlock(event: NormalizedEvent): PersistedBlock | null {
  switch (event.kind) {
    case "text":
      return { kind: "text", partID: event.partID, text: event.text };
    case "reasoning":
      return { kind: "reasoning", partID: event.partID, text: event.text };
    case "tool":
      return {
        kind: "tool",
        callID: event.callID,
        tool: event.tool,
        status: event.status,
        ...(event.input !== undefined ? { input: event.input } : {}),
        ...(event.output !== undefined ? { output: event.output } : {}),
        ...(event.error !== undefined ? { error: event.error } : {}),
        ...(event.title !== undefined ? { title: event.title } : {}),
        ...(event.metadata !== undefined ? { metadata: event.metadata } : {}),
      };
    default:
      return null;
  }
}

/**
 * The plain-text summary of an assistant turn: its text blocks joined in order. Persisted as the
 * message `content` (kept non-null like a user message) so a text-only reader — an export, a
 * search, a lineage-free view — sees the answer without parsing blocks. Reasoning and tool cards
 * live only in `blocks`.
 */
export function assistantMessageText(blocks: PersistedBlock[]): string {
  return blocks
    .filter((b): b is Extract<PersistedBlock, { kind: "text" }> => b.kind === "text")
    .map((b) => b.text)
    .join("");
}
