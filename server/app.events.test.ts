import { afterAll, describe, expect, it } from "vitest";
import { buildServer } from "./app.js";
import { createEventHub, type EventHub } from "./opencode/hub.js";
import type { EventBridge, NormalizedListener } from "./opencode/bridge.js";
import type { NormalizedEvent } from "./core/events.js";

/**
 * Route tests for `GET /api/events` (V1.5, FR3). The unwired (503) and bad-query (400) paths
 * are checked via `app.inject`; the streaming path is exercised over a real TCP socket with
 * `app.listen` + `fetch`, because SSE is a long-lived response that `inject` buffers forever
 * (see AGENTS.md). Driven by a fake bridge feeding a *real* {@link createEventHub}, so the
 * genuine per-session routing + monotonic-seq replay is asserted on the wire: the framed
 * event with its `id:` seq, the backlog replayed after `?lastSeq`, the per-session filter,
 * and the route unsubscribing from the hub on client disconnect.
 */

/** A controllable {@link EventBridge}: push normalized events into whatever the hub attaches. */
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
  };
}

/** Wrap a real hub to count live route↔hub subscriptions, so disconnect-unsubscribe is observable. */
function countingHub(inner: EventHub): { hub: EventHub; active: () => number } {
  let active = 0;
  const hub: EventHub = {
    subscribe(listener, options) {
      active += 1;
      const off = inner.subscribe(listener, options);
      return () => {
        active -= 1;
        off();
      };
    },
    publish(event) {
      inner.publish(event);
    },
    close() {
      inner.close();
    },
    lastSeq() {
      return inner.lastSeq();
    },
  };
  return { hub, active: () => active };
}

/** A minimal idle event for the given session. */
function idle(sessionID: string): NormalizedEvent {
  return { kind: "idle", sessionID };
}

/** An inline approval event (a paused write tool) for the given session. */
function approval(requestID: string, sessionID: string): NormalizedEvent {
  return {
    kind: "approval",
    sessionID,
    requestID,
    type: "run_transform",
    callID: "call_1",
    patterns: ["marts.report"],
    metadata: { sql: "CREATE TABLE marts.report AS SELECT 1" },
  };
}

/** Read from an SSE body stream until the buffered text contains `needle`, then return it. */
async function readerUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: InstanceType<typeof TextDecoder>,
  state: { buffered: string },
  needle: string,
): Promise<string> {
  while (!state.buffered.includes(needle)) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`stream ended before seeing ${needle}`);
    state.buffered += decoder.decode(value, { stream: true });
  }
  return state.buffered;
}

describe("GET /api/events", () => {
  const noHub = buildServer();

  afterAll(async () => {
    await noHub.close();
  });

  it("returns 503 when no event hub is wired", async () => {
    const res = await noHub.inject({ method: "GET", url: "/api/events" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "event stream unavailable" });
  });

  it("returns 400 for a malformed lastSeq cursor", async () => {
    const app = buildServer({ events: createEventHub(fakeBridge().bridge) });
    try {
      const res = await app.inject({ method: "GET", url: "/api/events?lastSeq=-1" });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: "invalid events query" });
    } finally {
      await app.close();
    }
  });

  it("streams sequenced SSE frames over a socket and unsubscribes on disconnect", async () => {
    const src = fakeBridge();
    const { hub, active } = countingHub(createEventHub(src.bridge));
    const app = buildServer({ events: hub });
    const address = await app.listen({ port: 0, host: "127.0.0.1" });

    try {
      const controller = new AbortController();
      const res = await fetch(`${address}/api/events`, {
        headers: { accept: "text/event-stream" },
        signal: controller.signal,
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/event-stream");
      expect(res.headers.get("cache-control")).toContain("no-cache");

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      const state = { buffered: "" };

      await readerUntil(reader, decoder, state, ": connected");
      expect(active()).toBe(1);

      // Emit a real event through the bridge → the hub sequences it → the route frames it.
      src.emit(idle("s1"));
      const wire = await readerUntil(reader, decoder, state, "event: idle");
      expect(wire).toContain("id: 1");
      expect(wire).toContain('data: {"kind":"idle","sessionID":"s1"}');

      // Client disconnects → the route must drop its hub subscription.
      await reader.cancel();
      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(active()).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("replays the backlog after ?lastSeq before streaming live", async () => {
    const src = fakeBridge();
    const app = buildServer({ events: createEventHub(src.bridge) });
    const address = await app.listen({ port: 0, host: "127.0.0.1" });

    try {
      // Three events buffered before any client connects.
      src.emit(idle("s1")); // seq 1
      src.emit(idle("s1")); // seq 2
      src.emit(idle("s1")); // seq 3

      const controller = new AbortController();
      const res = await fetch(`${address}/api/events?lastSeq=1`, {
        headers: { accept: "text/event-stream" },
        signal: controller.signal,
      });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      const state = { buffered: "" };

      // The backlog (seq 2, 3) replays immediately; seq 1 was before the cursor and is skipped.
      const backlog = await readerUntil(reader, decoder, state, "id: 3");
      expect(backlog).toContain("id: 2");
      expect(backlog).not.toContain("id: 1\n");

      // A live event afterwards continues the sequence.
      src.emit(idle("s1")); // seq 4
      const live = await readerUntil(reader, decoder, state, "id: 4");
      expect(live).toContain("id: 4");

      await reader.cancel();
      controller.abort();
    } finally {
      await app.close();
    }
  });

  it("scopes the stream to one session via ?sessionId", async () => {
    const src = fakeBridge();
    const app = buildServer({ events: createEventHub(src.bridge) });
    const address = await app.listen({ port: 0, host: "127.0.0.1" });

    try {
      const controller = new AbortController();
      const res = await fetch(`${address}/api/events?sessionId=s1`, {
        headers: { accept: "text/event-stream" },
        signal: controller.signal,
      });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      const state = { buffered: "" };
      await readerUntil(reader, decoder, state, ": connected");

      // Emit for another session first (seq 1, must be filtered out) then this one (seq 2).
      src.emit(idle("s2"));
      src.emit(idle("s1"));

      const wire = await readerUntil(reader, decoder, state, "event: idle");
      // The only framed event is s1's, and it carries seq 2 — proving s2's seq 1 was filtered.
      expect(wire).toContain("id: 2");
      expect(wire).toContain('"sessionID":"s1"');
      expect(wire).not.toContain('"sessionID":"s2"');

      await reader.cancel();
      controller.abort();
    } finally {
      await app.close();
    }
  });

  it("streams an inline approval on the `approval` channel with its SQL (FR10)", async () => {
    const src = fakeBridge();
    const app = buildServer({ events: createEventHub(src.bridge) });
    const address = await app.listen({ port: 0, host: "127.0.0.1" });

    try {
      const controller = new AbortController();
      const res = await fetch(`${address}/api/events?sessionId=s1`, {
        headers: { accept: "text/event-stream" },
        signal: controller.signal,
      });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      const state = { buffered: "" };
      await readerUntil(reader, decoder, state, ": connected");

      // A write tool pauses for approval → the browser sees it inline on the `approval` channel.
      src.emit(approval("perm_1", "s1"));
      const asked = await readerUntil(reader, decoder, state, "event: approval");
      expect(asked).toContain('"requestID":"perm_1"');
      expect(asked).toContain("CREATE TABLE marts.report AS SELECT 1");

      // Its resolution clears the pill on the `approval_resolved` channel.
      src.emit({
        kind: "approval_resolved",
        sessionID: "s1",
        requestID: "perm_1",
        status: "approved",
      });
      const resolved = await readerUntil(reader, decoder, state, "event: approval_resolved");
      expect(resolved).toContain('"requestID":"perm_1"');
      expect(resolved).toContain('"status":"approved"');

      await reader.cancel();
      controller.abort();
    } finally {
      await app.close();
    }
  });
});
