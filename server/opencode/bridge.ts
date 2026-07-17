import type { Event, OpencodeClient, Part } from "@opencode-ai/sdk";
import type { NormalizedEvent } from "../core/events.js";

/**
 * OpenCode → normalized chat-event bridge (TASKS V1.4, PRD FR2/FR3). Subscribes **once** to
 * the runtime's global event stream, maps each raw event to a {@link NormalizedEvent} (text
 * delta / reasoning / tool-call w/ status / idle / error) via {@link normalizeEvent}, and
 * fans the normalized events out to its subscribers. It also exposes every raw event via
 * `onRawEvent` so the permission gate (V1.6) can read `permission.updated` off the same
 * single pump — the platform reads `event.subscribe()` exactly once. The per-session
 * routing + replay buffer over these normalized events is the SSE route (V1.5). See
 * ARCHITECTURE §6.
 */

/** Minimal client slice the bridge needs: the `event.subscribe()` stream. */
export type EventClient = Pick<OpencodeClient, "event">;

/**
 * The runtime error union carried by a `session.error` event's `properties.error`. Each
 * member is `{ name, data }`; only some `data` shapes carry a `message`.
 */
interface RuntimeError {
  name?: string;
  data?: { message?: unknown };
}

/** Extract a human-readable message from a `session.error` payload, with sane fallbacks. */
function errorMessage(error: RuntimeError | undefined): string {
  if (!error) return "session error";
  const message = error.data?.message;
  if (typeof message === "string" && message.length > 0) return message;
  if (typeof error.name === "string" && error.name.length > 0) return error.name;
  return "session error";
}

/** Map a streamed message `Part` to a normalized event, or `null` if it is not chat content. */
function normalizePart(part: Part): NormalizedEvent | null {
  switch (part.type) {
    case "text": {
      // Synthetic parts are runtime-injected (not genuine streamed output) — skip them.
      if (part.synthetic) return null;
      return {
        kind: "text",
        sessionID: part.sessionID,
        messageID: part.messageID,
        partID: part.id,
        text: part.text,
      };
    }
    case "reasoning":
      return {
        kind: "reasoning",
        sessionID: part.sessionID,
        messageID: part.messageID,
        partID: part.id,
        text: part.text,
      };
    case "tool": {
      const state = part.state;
      return {
        kind: "tool",
        sessionID: part.sessionID,
        messageID: part.messageID,
        partID: part.id,
        callID: part.callID,
        tool: part.tool,
        status: state.status,
        input: state.input,
        output: state.status === "completed" ? state.output : undefined,
        error: state.status === "error" ? state.error : undefined,
        title:
          state.status === "running" || state.status === "completed"
            ? state.title
            : undefined,
      };
    }
    // file / step-start / step-finish / snapshot / agent / patch parts are not chat content.
    default:
      return null;
  }
}

/**
 * Map one raw OpenCode event to the normalized chat event the UI renders, or `null` when
 * the event is not part of the chat stream (message envelopes, session status, file
 * watchers, permission events — those go to the approval gate, not here). Pure and total:
 * this is the mapping V1.4 unit-tests. A `session.error` with no session id can't be routed
 * per session, so it is dropped rather than emitted unattributed.
 */
export function normalizeEvent(event: Event): NormalizedEvent | null {
  switch (event.type) {
    case "message.part.updated":
      return normalizePart(event.properties.part);
    case "session.idle":
      return { kind: "idle", sessionID: event.properties.sessionID };
    case "session.error": {
      const sessionID = event.properties.sessionID;
      if (!sessionID) return null;
      return {
        kind: "error",
        sessionID,
        message: errorMessage(event.properties.error as RuntimeError | undefined),
      };
    }
    default:
      return null;
  }
}

/** Receives one normalized event as it arrives from the runtime. */
export type NormalizedListener = (event: NormalizedEvent) => void;

/** The event bridge surface consumed by the SSE route (V1.5) and the boot wiring. */
export interface EventBridge {
  /**
   * Subscribe to the normalized event stream. The listener fires for every event across all
   * sessions (the SSE route filters per session, V1.5). Returns an unsubscribe function.
   */
  subscribe(listener: NormalizedListener): () => void;
  /** Stop the event pump and drop all subscribers. Idempotent. */
  close(): Promise<void>;
}

export interface EventBridgeOptions {
  /**
   * Observer for every raw event read from the runtime, before normalization. The permission
   * gate (FR8/FR10) hooks here to see `permission.updated`/`permission.replied`, and boot
   * smoke tests hook here to observe the live stream — so `event.subscribe()` is read once.
   */
  onRawEvent?: (event: Event) => void;
  /**
   * Called if the event stream terminates with an error while the bridge is still open, so a
   * dropped subscription surfaces instead of silently ending the stream.
   */
  onError?: (error: unknown) => void;
}

/**
 * Create the event bridge and immediately start pumping the runtime's event stream. The pump
 * runs until {@link EventBridge.close} aborts it; the SDK's SSE client reconnects on transient
 * network errors on its own, so only a terminal failure reaches `onError`.
 */
export function createEventBridge(
  client: EventClient,
  options: EventBridgeOptions = {},
): EventBridge {
  const listeners = new Set<NormalizedListener>();
  const abort = new AbortController();
  let closed = false;

  /** Feed the raw event to observers, then fan its normalized form to subscribers. */
  function dispatch(event: Event): void {
    options.onRawEvent?.(event);
    const normalized = normalizeEvent(event);
    if (!normalized) return;
    for (const listener of listeners) listener(normalized);
  }

  async function pump(): Promise<void> {
    const { stream } = await client.event.subscribe({ signal: abort.signal });
    for await (const event of stream) {
      if (closed) break;
      dispatch(event as Event);
    }
  }

  // Fire-and-forget: the pump lives for the bridge's lifetime. Swallow the abort error raised
  // by close(); surface any other terminal failure via onError.
  void pump().catch((error) => {
    if (closed) return;
    options.onError?.(error);
  });

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      abort.abort();
      listeners.clear();
    },
  };
}
