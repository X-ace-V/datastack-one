import { describe, expect, it } from "vitest";
import { createEventHub } from "./hub.js";
import type { EventBridge, NormalizedListener } from "./bridge.js";
import type { NormalizedEvent, SequencedEvent } from "../core/events.js";

/**
 * Unit tests for the event hub (V1.5, FR3) — the per-session, replayable fan-out between the
 * normalized event bridge and the `GET /api/events` SSE route. Driven by a fake bridge (no
 * `opencode` subprocess) so the invariants the route rests on are asserted directly: monotonic
 * sequencing, per-session scoping, backlog-then-live replay with no gap or duplicate, clean
 * unsubscribe, and detachment on close. See LOOP.md §5 — assert values, not just "it ran".
 */

/** A controllable {@link EventBridge}: push normalized events and observe attach/detach. */
function fakeBridge() {
  const listeners = new Set<NormalizedListener>();
  const bridge: EventBridge = {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async close() {
      listeners.clear();
    },
  };
  return {
    bridge,
    emit(event: NormalizedEvent) {
      for (const listener of listeners) listener(event);
    },
    listenerCount() {
      return listeners.size;
    },
  };
}

/** A minimal idle event for the given session. */
function idle(sessionID: string): NormalizedEvent {
  return { kind: "idle", sessionID };
}

describe("createEventHub", () => {
  it("delivers live events to a subscriber with monotonic seqs", () => {
    const src = fakeBridge();
    const hub = createEventHub(src.bridge);
    const got: SequencedEvent[] = [];
    hub.subscribe((e) => got.push(e));

    src.emit(idle("s1"));
    src.emit(idle("s2"));

    expect(got).toEqual([
      { seq: 1, event: idle("s1") },
      { seq: 2, event: idle("s2") },
    ]);
    expect(hub.lastSeq()).toBe(2);
  });

  it("publish() injects a backend event, sequenced + fanned like a bridge event", () => {
    const src = fakeBridge();
    const hub = createEventHub(src.bridge);
    const got: SequencedEvent[] = [];
    hub.subscribe((e) => got.push(e), { sessionId: "s1" });

    src.emit(idle("s1")); // seq 1 from the bridge
    // A backend-originated approval (V4.1) rides the same stream via publish().
    const approval: NormalizedEvent = {
      kind: "approval",
      sessionID: "s1",
      requestID: "req_1",
      type: "run_transform",
      metadata: { sql: "SELECT 1" },
    };
    hub.publish(approval); // seq 2, injected
    hub.publish({ kind: "approval", sessionID: "s2", requestID: "req_2", type: "land_parquet", metadata: {} }); // filtered

    expect(got).toEqual([
      { seq: 1, event: idle("s1") },
      { seq: 2, event: approval },
    ]);
    // The filtered publish still consumed a global seq — publish and bridge share one counter.
    expect(hub.lastSeq()).toBe(3);
  });

  it("a fresh subscriber (no lastSeq) receives no backlog, only live events", () => {
    const src = fakeBridge();
    const hub = createEventHub(src.bridge);
    src.emit(idle("s1")); // buffered as seq 1, before anyone subscribes

    const got: SequencedEvent[] = [];
    hub.subscribe((e) => got.push(e));
    src.emit(idle("s1")); // seq 2, live

    expect(got).toEqual([{ seq: 2, event: idle("s1") }]);
  });

  it("scopes delivery to one session when sessionId is given", () => {
    const src = fakeBridge();
    const hub = createEventHub(src.bridge);
    const got: SequencedEvent[] = [];
    hub.subscribe((e) => got.push(e), { sessionId: "s1" });

    src.emit(idle("s1")); // seq 1 — delivered
    src.emit(idle("s2")); // seq 2 — filtered out
    src.emit(idle("s1")); // seq 3 — delivered

    expect(got.map((e) => e.seq)).toEqual([1, 3]);
    // The filtered event still consumed a global seq, so the seqs are not renumbered per session.
    expect(hub.lastSeq()).toBe(3);
  });

  it("replays the backlog after lastSeq, then continues live with no duplicate", () => {
    const src = fakeBridge();
    const hub = createEventHub(src.bridge);
    src.emit(idle("s1")); // seq 1
    src.emit(idle("s1")); // seq 2
    src.emit(idle("s1")); // seq 3

    const got: SequencedEvent[] = [];
    hub.subscribe((e) => got.push(e), { lastSeq: 1 });
    // Backlog (seq 2,3) delivered synchronously on subscribe.
    expect(got.map((e) => e.seq)).toEqual([2, 3]);

    src.emit(idle("s1")); // seq 4, live
    expect(got.map((e) => e.seq)).toEqual([2, 3, 4]);
  });

  it("scopes the replayed backlog to the subscriber's session", () => {
    const src = fakeBridge();
    const hub = createEventHub(src.bridge);
    src.emit(idle("s1")); // seq 1
    src.emit(idle("s2")); // seq 2
    src.emit(idle("s1")); // seq 3

    const got: SequencedEvent[] = [];
    hub.subscribe((e) => got.push(e), { sessionId: "s1", lastSeq: 0 });
    expect(got.map((e) => e.seq)).toEqual([1, 3]);
  });

  it("stops delivering to a listener after it unsubscribes", () => {
    const src = fakeBridge();
    const hub = createEventHub(src.bridge);
    const got: SequencedEvent[] = [];
    const unsubscribe = hub.subscribe((e) => got.push(e));

    src.emit(idle("s1"));
    expect(got).toHaveLength(1);
    unsubscribe();
    src.emit(idle("s1"));
    expect(got).toHaveLength(1);
  });

  it("fans one event to every open subscriber independently", () => {
    const src = fakeBridge();
    const hub = createEventHub(src.bridge);
    const a: number[] = [];
    const b: number[] = [];
    hub.subscribe((e) => a.push(e.seq));
    hub.subscribe((e) => b.push(e.seq), { sessionId: "s2" });

    src.emit(idle("s1")); // seq 1 → only a (b is scoped to s2)
    src.emit(idle("s2")); // seq 2 → both

    expect(a).toEqual([1, 2]);
    expect(b).toEqual([2]);
  });

  it("detaches from the bridge and drops subscribers on close", () => {
    const src = fakeBridge();
    const hub = createEventHub(src.bridge);
    const got: SequencedEvent[] = [];
    hub.subscribe((e) => got.push(e));
    expect(src.listenerCount()).toBe(1);

    hub.close();
    expect(src.listenerCount()).toBe(0);
    src.emit(idle("s1"));
    expect(got).toEqual([]);
  });
});
