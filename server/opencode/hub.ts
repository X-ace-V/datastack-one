import {
  DEFAULT_REPLAY_BUFFER_SIZE,
  ReplayBuffer,
  type NormalizedEvent,
  type SequencedEvent,
} from "../core/events.js";
import type { EventBridge } from "./bridge.js";

/**
 * The event hub (TASKS V1.5, PRD FR3): the fan-out layer between the OpenCode → normalized
 * event bridge ({@link file://./bridge.js}) and the `GET /api/events` SSE route
 * ({@link file://../app.ts}). It subscribes to the bridge **once**, assigns each normalized
 * event a monotonic sequence number via a {@link ReplayBuffer}, and delivers it live to every
 * open SSE connection — filtered per session. A reconnecting client passes the last `seq` it
 * saw and is replayed the backlog (scoped to its session) before the live stream resumes,
 * with no gap and no duplicate. Mirrors Crux `sse.ts`.
 */

/** Options a subscriber uses to scope + resume its slice of the event stream. */
export interface EventStreamOptions {
  /** Only deliver events for this session. Omit to receive every session's events. */
  sessionId?: string;
  /**
   * Replay retained events with a sequence number greater than this before going live
   * (reconnect). Omit for a fresh connection that only wants events from now on.
   */
  lastSeq?: number;
}

/** Receives one sequenced event as it is delivered to this subscriber. */
export type SequencedListener = (event: SequencedEvent) => void;

/** The hub surface consumed by the SSE route and the boot wiring. */
export interface EventHub {
  /**
   * Subscribe to the (optionally session-scoped) event stream. If `lastSeq` is given, the
   * matching backlog is delivered synchronously first, then live events follow. Returns an
   * unsubscribe function the route calls when the client disconnects.
   */
  subscribe(listener: SequencedListener, options?: EventStreamOptions): () => void;
  /** Detach from the bridge and drop all subscribers. Idempotent-safe for shutdown. */
  close(): void;
  /** The highest sequence number assigned so far — for tests/diagnostics. */
  lastSeq(): number;
}

interface Subscriber {
  readonly fn: SequencedListener;
  readonly sessionId?: string;
}

/**
 * Create the event hub over an {@link EventBridge}. It attaches to the bridge immediately; the
 * `capacity` bounds the replay buffer (see {@link DEFAULT_REPLAY_BUFFER_SIZE}).
 */
export function createEventHub(
  bridge: EventBridge,
  capacity: number = DEFAULT_REPLAY_BUFFER_SIZE,
): EventHub {
  const buffer = new ReplayBuffer(capacity);
  const subscribers = new Set<Subscriber>();

  // Single attachment to the bridge: sequence every event, then fan it to matching subscribers.
  const detach = bridge.subscribe((event: NormalizedEvent) => {
    const sequenced = buffer.append(event);
    for (const sub of subscribers) {
      if (sub.sessionId === undefined || sub.sessionId === event.sessionID) {
        sub.fn(sequenced);
      }
    }
  });

  return {
    subscribe(listener, options = {}) {
      const { sessionId, lastSeq } = options;
      // Replay the backlog, then register for live events in the SAME synchronous tick. This
      // is the no-gap / no-duplicate guarantee: every replayed event has seq ≤ the buffer's
      // current max, every subsequent live event has a strictly greater seq, and because the
      // bridge's pump only dispatches on a later task there is no interleaving in between.
      if (lastSeq !== undefined) {
        for (const sequenced of buffer.replay(lastSeq, sessionId)) listener(sequenced);
      }
      const subscriber: Subscriber = { fn: listener, sessionId };
      subscribers.add(subscriber);
      return () => {
        subscribers.delete(subscriber);
      };
    },
    close() {
      detach();
      subscribers.clear();
    },
    lastSeq() {
      return buffer.lastSeq;
    },
  };
}
