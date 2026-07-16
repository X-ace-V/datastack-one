import type { Event, OpencodeClient } from "@opencode-ai/sdk";
import { formatSseFrame, type RunProgressPayload } from "../core/events.js";

/**
 * OpenCode → SSE progress bridge (TASKS T1.3, PRD FR9). Subscribes once to the runtime's
 * global event stream and fans each event out to the SSE subscribers of the run whose
 * session produced it. A run is bound to an OpenCode session by the pipeline runner
 * (T4.4) via {@link RunBridge.bindSession}; until a run is bound it has no progress. This
 * is the one place the platform reads `event.subscribe()`. See ARCHITECTURE §6.
 */

/** OpenCode event types surfaced to the UI as run progress (FR9). */
export const PROGRESS_EVENT_TYPES: ReadonlySet<string> = new Set([
  // The assistant message envelope: role, model, timing.
  "message.updated",
  // Streamed message parts: agent reasoning text and tool calls (the main signal).
  "message.part.updated",
  // Coarse busy/retry/idle status for the session.
  "session.status",
  // The session finished its turn — a stage completed.
  "session.idle",
  // The session's turn failed — a stage errored.
  "session.error",
]);

/** Whether an event type is relayed to a run's progress stream. */
export function isProgressEvent(type: string): boolean {
  return PROGRESS_EVENT_TYPES.has(type);
}

/**
 * Extract the OpenCode session id an event belongs to, or `undefined` if the event is not
 * session-scoped. The id lives in different places by event shape: most carry it directly
 * under `properties.sessionID`, `message.updated` nests it under `properties.info`, and
 * `message.part.updated` nests it under `properties.part`.
 */
export function sessionIdOf(event: Event): string | undefined {
  const props = event.properties as Record<string, unknown> | undefined;
  if (!props) return undefined;
  if (typeof props.sessionID === "string") return props.sessionID;
  const info = props.info as { sessionID?: unknown } | undefined;
  if (info && typeof info.sessionID === "string") return info.sessionID;
  const part = props.part as { sessionID?: unknown } | undefined;
  if (part && typeof part.sessionID === "string") return part.sessionID;
  return undefined;
}

/** Receives a fully-formatted SSE frame string, ready to write to the response socket. */
export type FrameSink = (frame: string) => void;

/** Public bridge surface consumed by the SSE route and (later) the pipeline runner. */
export interface RunBridge {
  /** Associate a run with the OpenCode session whose events feed its progress stream. */
  bindSession(runId: string, sessionID: string): void;
  /**
   * Subscribe a client to a run's SSE frames. Returns an unsubscribe function that the
   * route calls when the browser disconnects, so dead sockets are dropped.
   */
  subscribe(runId: string, sink: FrameSink): () => void;
  /** Stop the event pump and drop all subscribers. Idempotent. */
  close(): Promise<void>;
}

/** Minimal client slice the bridge needs: the `event.subscribe()` stream. */
export type EventClient = Pick<OpencodeClient, "event">;

export interface RunBridgeOptions {
  /**
   * Observer for every raw event read from the runtime, before progress filtering. The
   * lineage recorder (FR12) and boot smoke tests hook here to see the live stream.
   */
  onEvent?: (event: Event) => void;
  /**
   * Called if the event stream terminates with an error while the bridge is still open,
   * so a dropped subscription surfaces instead of silently ending progress.
   */
  onError?: (error: unknown) => void;
}

/**
 * Create the run bridge and immediately start pumping the runtime's event stream. The
 * pump runs until {@link RunBridge.close} aborts it; the SDK's SSE client reconnects on
 * transient network errors on its own, so only a terminal failure reaches `onError`.
 */
export function createRunBridge(
  client: EventClient,
  options: RunBridgeOptions = {},
): RunBridge {
  // sessionID → runId. One session backs one run in the MVP's scripted pipeline.
  const runBySession = new Map<string, string>();
  // runId → its set of connected SSE sinks (a run may have multiple viewers).
  const sinksByRun = new Map<string, Set<FrameSink>>();
  const abort = new AbortController();
  let closed = false;

  /** Route one raw event to the sinks of the run it belongs to, if any. */
  function dispatch(event: Event): void {
    options.onEvent?.(event);
    if (!isProgressEvent(event.type)) return;
    const sessionID = sessionIdOf(event);
    if (!sessionID) return;
    const runId = runBySession.get(sessionID);
    if (!runId) return;
    const sinks = sinksByRun.get(runId);
    if (!sinks || sinks.size === 0) return;
    const payload: RunProgressPayload = {
      runId,
      type: event.type,
      properties: event.properties,
    };
    const frame = formatSseFrame({ event: event.type, data: payload });
    for (const sink of sinks) sink(frame);
  }

  async function pump(): Promise<void> {
    const { stream } = await client.event.subscribe({ signal: abort.signal });
    for await (const event of stream) {
      if (closed) break;
      dispatch(event as Event);
    }
  }

  // Fire-and-forget: the pump lives for the bridge's lifetime. Swallow the abort error
  // raised by close(); surface any other terminal failure via onError.
  void pump().catch((error) => {
    if (closed) return;
    options.onError?.(error);
  });

  return {
    bindSession(runId, sessionID) {
      runBySession.set(sessionID, runId);
    },
    subscribe(runId, sink) {
      let sinks = sinksByRun.get(runId);
      if (!sinks) {
        sinks = new Set();
        sinksByRun.set(runId, sinks);
      }
      sinks.add(sink);
      return () => {
        const set = sinksByRun.get(runId);
        if (!set) return;
        set.delete(sink);
        if (set.size === 0) sinksByRun.delete(runId);
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      abort.abort();
      runBySession.clear();
      sinksByRun.clear();
    },
  };
}
