// The chat SSE hook (TASKS V2.2, PRD FR3, ARCHITECTURE §4). One `EventSource` on
// `GET /api/events` relays the whole app's normalized chat stream; a named handler per event
// kind parses each frame and routes it into the live-state store (`useSessionStore.handleEvent`),
// which fans it to the right session by `event.sessionID`. On a dropped connection the hook
// reconnects, resuming from the last sequence number it saw via `?lastSeq` so the backlog in the
// server's replay buffer is delivered without gap or duplicate. Mirrors Crux `useWorkspaceSSE`,
// sized to this app's single global stream (the store does the per-session routing).
//
// Why named channels: the SSE route sets each frame's `event:` field to the event's `kind`
// (`text`/`reasoning`/`tool`/…), so the browser's default `message` listener never fires — the
// hook must `addEventListener(kind, …)` for every kind. Missing one silently drops that event.

import { useEffect, useRef, useState } from "react";
import type { NormalizedEvent } from "../store/sessionStore";

/** Default endpoint — the Vite dev server proxies `/api/*` to the Fastify backend. */
const DEFAULT_URL = "/api/events";

/** Default delay before a manual reconnect after the stream closes/errors. */
const DEFAULT_RECONNECT_DELAY_MS = 1000;

/**
 * The named SSE channels the hook subscribes to — one per {@link NormalizedEvent} kind, matching
 * the `event:` field the SSE route stamps on each frame. `satisfies` proves every entry is a real
 * kind; the `_AllKindsListed` assertion below proves none is missing, so adding a new event kind
 * that isn't listed here is a compile error rather than a silently-dropped channel.
 */
const CHANNELS = [
  "text",
  "reasoning",
  "tool",
  "idle",
  "error",
  "approval",
  "approval_resolved",
  "session_updated",
  "session_status",
] as const satisfies readonly NormalizedEvent["kind"][];

// Compile-time completeness: fails to typecheck if a NormalizedEvent kind is not in CHANNELS.
type _AllKindsListed =
  Exclude<NormalizedEvent["kind"], (typeof CHANNELS)[number]> extends never ? true : never;
const _assertAllKindsListed: _AllKindsListed = true;
void _assertAllKindsListed;

/** The live connection status, for a UI indicator. */
export type EventsStatus = "connecting" | "open" | "closed";

export interface UseEventsOptions {
  /**
   * Called with each normalized event, in arrival order. In the app this is the store's
   * `handleEvent`, which routes the event to its session by `event.sessionID`.
   */
  onEvent: (event: NormalizedEvent) => void;
  /** Where the stream lives. Defaults to `/api/events`. */
  url?: string;
  /** Fired each time the stream (re)connects. */
  onOpen?: () => void;
  /** Fired when the stream errors, before a reconnect is scheduled. */
  onError?: (event: Event) => void;
  /** Milliseconds to wait before reconnecting after a close/error. Defaults to 1000. */
  reconnectDelayMs?: number;
  /** Open the stream while true; false leaves it closed (e.g. before a session exists). */
  enabled?: boolean;
}

export interface EventsConnection {
  /** The current connection status. */
  status: EventsStatus;
  /** The highest sequence number seen — what the next reconnect resumes after (`?lastSeq`). */
  lastSeq: number;
}

/** Append `?lastSeq=<n>` (or `&lastSeq`) so a reconnect resumes after the last event seen. */
function withLastSeq(url: string, lastSeq: number): string {
  if (lastSeq <= 0) return url;
  return `${url}${url.includes("?") ? "&" : "?"}lastSeq=${lastSeq}`;
}

/**
 * Subscribe to the chat event stream and route every event into the store. Returns the live
 * connection {@link EventsConnection} for an optional status indicator. The callbacks are held
 * in refs so changing them does not tear down and reopen the connection — only `url`, `enabled`,
 * or `reconnectDelayMs` do. The single `EventSource` outlives session switches (the store keys
 * everything by session), and its `lastSeq` cursor survives reconnects so no event is missed.
 */
export function useEvents(options: UseEventsOptions): EventsConnection {
  const {
    onEvent,
    url = DEFAULT_URL,
    onOpen,
    onError,
    reconnectDelayMs = DEFAULT_RECONNECT_DELAY_MS,
    enabled = true,
  } = options;

  const [status, setStatus] = useState<EventsStatus>(enabled ? "connecting" : "closed");
  const [lastSeq, setLastSeq] = useState(0);

  // Callbacks via refs so a new inline handler each render doesn't reconnect the stream.
  const onEventRef = useRef(onEvent);
  const onOpenRef = useRef(onOpen);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onEventRef.current = onEvent;
    onOpenRef.current = onOpen;
    onErrorRef.current = onError;
  });

  // Persist the resume cursor across reconnects — the effect below must not reset it.
  const lastSeqRef = useRef(0);

  useEffect(() => {
    if (!enabled) {
      setStatus("closed");
      return;
    }

    let mounted = true;
    let source: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    const handleMessage = (event: MessageEvent) => {
      if (!mounted) return;
      // The frame's `id:` is the monotonic seq; advance the resume cursor before parsing so a
      // reconnect right after this event still resumes from the right place.
      const seq = Number(event.lastEventId);
      if (Number.isInteger(seq) && seq > lastSeqRef.current) {
        lastSeqRef.current = seq;
        setLastSeq(seq);
      }
      let parsed: NormalizedEvent;
      try {
        parsed = JSON.parse(event.data) as NormalizedEvent;
      } catch {
        // A malformed frame is dropped rather than crashing the stream.
        return;
      }
      onEventRef.current(parsed);
    };

    const scheduleReconnect = () => {
      if (!mounted) return;
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => {
        if (mounted) connect();
      }, reconnectDelayMs);
    };

    const connect = () => {
      source?.close();
      setStatus("connecting");
      const es = new EventSource(withLastSeq(url, lastSeqRef.current));
      source = es;
      es.addEventListener("open", () => {
        if (!mounted) return;
        setStatus("open");
        onOpenRef.current?.();
      });
      es.addEventListener("error", (event) => {
        onErrorRef.current?.(event);
        if (!mounted) return;
        setStatus("connecting");
        // Take control of reconnection so it always resumes via `?lastSeq`: close the native
        // source (which would otherwise auto-retry without our cursor) and reopen ourselves.
        es.close();
        scheduleReconnect();
      });
      // Custom channel names aren't in `EventSourceEventMap`, so the DOM types the listener as a
      // bare `EventListener` (`Event`); every frame the server sends on these is a `MessageEvent`.
      for (const channel of CHANNELS) es.addEventListener(channel, handleMessage as EventListener);
    };

    connect();

    return () => {
      mounted = false;
      clearTimeout(reconnectTimer);
      source?.close();
      source = null;
    };
  }, [enabled, url, reconnectDelayMs]);

  return { status, lastSeq };
}
