import { z } from "zod";

/**
 * Pure SSE (Server-Sent Events) framing + the normalized chat-event contract. The OpenCode
 * event bridge ({@link file://../opencode/bridge.ts}) reads the runtime's raw event stream,
 * maps each event to a {@link NormalizedEvent} (or drops it), and the SSE route
 * (`GET /api/events`, V1.5) frames each with {@link formatSseFrame} and routes it to the
 * right session's subscribers. Keeping the wire format + the event shape here — pure, no
 * fs/net/process — lets both be unit-tested directly and reused by any SSE endpoint. See
 * ARCHITECTURE §6, PRD FR2/FR3.
 */

/** One Server-Sent Event to serialize onto the wire. */
export interface SseFrame {
  /** SSE `event:` field — the named channel a browser `EventSource` listens on. */
  event?: string;
  /** SSE `id:` field — optional event id (lets a client resume via `Last-Event-ID`). */
  id?: string;
  /** Payload written as the `data:` field, JSON-encoded. */
  data: unknown;
}

/**
 * Serialize a frame into the SSE wire format: optional `id:`/`event:` lines, then one
 * `data:` line per line of the JSON body (the spec requires each physical line to be its
 * own `data:` field, so a body containing `\n` must be split), terminated by the blank
 * line that ends an event. The result is ready to write straight to the response socket.
 */
export function formatSseFrame(frame: SseFrame): string {
  const lines: string[] = [];
  if (frame.id !== undefined) lines.push(`id: ${frame.id}`);
  if (frame.event !== undefined) lines.push(`event: ${frame.event}`);
  const json = JSON.stringify(frame.data ?? null);
  for (const dataLine of json.split("\n")) lines.push(`data: ${dataLine}`);
  return `${lines.join("\n")}\n\n`;
}

/**
 * The normalized event kinds surfaced to the chat UI (PRD FR2/FR3): streamed assistant
 * `text`, agent `reasoning`, a `tool` call with its status, the turn going `idle`, and a
 * turn `error`. Every other raw OpenCode event (message envelopes, session status, file
 * watchers, permission events — handled by the approval bridge) maps to `null` and is not
 * relayed to the chat stream.
 */
export const NORMALIZED_EVENT_KINDS = [
  "text",
  "reasoning",
  "tool",
  "idle",
  "error",
] as const;
export type NormalizedEventKind = (typeof NORMALIZED_EVENT_KINDS)[number];

/**
 * OpenCode's native tool-call statuses (the `ToolState.status` values). Distinct from the
 * deterministic runner's lineage statuses in {@link file://./lineage.ts} — these track a
 * live agent-invoked tool call as it streams: queued → executing → done/failed.
 */
export const NORMALIZED_TOOL_STATUSES = [
  "pending",
  "running",
  "completed",
  "error",
] as const;
export type NormalizedToolStatus = (typeof NORMALIZED_TOOL_STATUSES)[number];

/** Fields every normalized event carries so the SSE route can route it per session. */
const baseFields = {
  /** The OpenCode session this event belongs to — the SSE routing key (FR3). */
  sessionID: z.string().min(1),
};

/** A streamed chunk of assistant message text (accumulates by `partID`). */
export const TextEventSchema = z.object({
  ...baseFields,
  kind: z.literal("text"),
  /** The assistant message this text belongs to. */
  messageID: z.string().min(1),
  /** The message part id — the stable key the UI updates in place as text streams. */
  partID: z.string().min(1),
  /** The part's current text (the full accumulated text of this part, not just the delta). */
  text: z.string(),
});
export type TextEvent = z.infer<typeof TextEventSchema>;

/** A streamed chunk of the agent's reasoning (rendered separately from the answer). */
export const ReasoningEventSchema = z.object({
  ...baseFields,
  kind: z.literal("reasoning"),
  messageID: z.string().min(1),
  partID: z.string().min(1),
  text: z.string(),
});
export type ReasoningEvent = z.infer<typeof ReasoningEventSchema>;

/**
 * A tool call and its current status, rendered as a tool card. Carries the model-produced
 * `input` (its arguments), and — once terminal — the `output` (completed) or `error`.
 * Note (FR5b): a source is referenced by **name**, never a URL, so nothing secret ever
 * reaches this `input` and thus never the SSE stream.
 */
export const ToolEventSchema = z.object({
  ...baseFields,
  kind: z.literal("tool"),
  messageID: z.string().min(1),
  partID: z.string().min(1),
  /** The tool-call id — stable across the pending→running→terminal status updates. */
  callID: z.string().min(1),
  /** The tool being called, e.g. `profile_source` / `run_query`. */
  tool: z.string().min(1),
  /** Where the call is in its lifecycle. */
  status: z.enum(NORMALIZED_TOOL_STATUSES),
  /** The model-produced arguments (present in every ToolState). */
  input: z.record(z.string(), z.unknown()).optional(),
  /** The tool's result, once it has completed. */
  output: z.string().optional(),
  /** The failure detail, if the call errored. */
  error: z.string().optional(),
  /** A short human-readable title the runtime attaches while running/after completion. */
  title: z.string().optional(),
});
export type ToolEvent = z.infer<typeof ToolEventSchema>;

/** The turn finished — the agent is idle and awaiting the next prompt. */
export const IdleEventSchema = z.object({
  ...baseFields,
  kind: z.literal("idle"),
});
export type IdleEvent = z.infer<typeof IdleEventSchema>;

/** The turn failed — surfaced in the chat instead of a silent stall (FR2). */
export const ErrorEventSchema = z.object({
  ...baseFields,
  kind: z.literal("error"),
  /** A human-readable failure message extracted from the runtime error. */
  message: z.string(),
});
export type ErrorEvent = z.infer<typeof ErrorEventSchema>;

/**
 * The normalized chat event delivered over `GET /api/events` (FR3). A discriminated union
 * on `kind` so the browser store can switch on it exhaustively, and every member carries a
 * `sessionID` so the SSE route can fan it out to the right session's subscribers.
 */
export const NormalizedEventSchema = z.discriminatedUnion("kind", [
  TextEventSchema,
  ReasoningEventSchema,
  ToolEventSchema,
  IdleEventSchema,
  ErrorEventSchema,
]);
export type NormalizedEvent = z.infer<typeof NormalizedEventSchema>;
