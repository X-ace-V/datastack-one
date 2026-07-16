import { z } from "zod";

/**
 * Pure SSE (Server-Sent Events) framing + the run-progress payload contract. The OpenCode
 * bridge ({@link file://../opencode/bridge.ts}) reads the runtime's event stream, filters
 * it to the events for a given run's session, and serializes each with
 * {@link formatSseFrame} for `GET /api/runs/:runId/events` (PRD FR9). Keeping the wire
 * format here — pure, no fs/net/process — lets the framing be unit-tested directly and
 * reused by any future SSE endpoint. See ARCHITECTURE §6.
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
 * The payload delivered as an SSE frame's `data` for a run-progress event: the run it
 * belongs to plus the OpenCode event `type` and its `properties`, forwarded verbatim so
 * the UI can render the agent's reasoning, tool calls, and per-stage status (FR9). The
 * `properties` shape varies by event type, so it is carried opaquely and rendered by the
 * client, not re-validated here.
 */
export const RunProgressPayloadSchema = z.object({
  /** The run this progress belongs to (the `:runId` path param of the SSE route). */
  runId: z.string().min(1),
  /** The OpenCode event type, e.g. `message.part.updated` / `session.status`. */
  type: z.string().min(1),
  /** The event's properties, forwarded verbatim for the UI to render. */
  properties: z.unknown(),
});
export type RunProgressPayload = z.infer<typeof RunProgressPayloadSchema>;
