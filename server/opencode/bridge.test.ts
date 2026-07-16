import { describe, expect, it } from "vitest";
import type { Event } from "@opencode-ai/sdk";
import {
  createRunBridge,
  isProgressEvent,
  sessionIdOf,
  type EventClient,
} from "./bridge.js";
import { RunProgressPayloadSchema } from "../core/events.js";

/**
 * Unit tests for the OpenCode → SSE bridge (T1.3). The bridge is driven by a hand-built
 * event stream (no `opencode` subprocess) so we can assert the desired routing/framing:
 * a progress event for a bound session reaches exactly that run's sink as a valid SSE
 * frame, and everything else (non-progress types, unbound sessions, unsubscribed sinks)
 * produces nothing. See LOOP.md §5 — assert values and invariants, not just "it ran".
 */

/** A controllable async event stream: push events, then end, mimicking `event.subscribe`. */
function makeEventStream() {
  const queue: Event[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  async function* gen(): AsyncGenerator<Event> {
    while (true) {
      if (queue.length > 0) {
        yield queue.shift()!;
        continue;
      }
      if (done) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  }
  return {
    stream: gen(),
    push(event: Event) {
      queue.push(event);
      wake?.();
      wake = null;
    },
    end() {
      done = true;
      wake?.();
      wake = null;
    },
  };
}

/** Build an `EventClient` whose `event.subscribe()` returns the given stream. */
function mockClient(stream: AsyncGenerator<Event>): EventClient {
  return {
    event: { subscribe: async () => ({ stream }) },
  } as unknown as EventClient;
}

/** Yield to the pump so a pushed event is dispatched before assertions run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Minimal progress event for `sessionID`, carried in the shape that event type uses. */
function partEvent(sessionID: string, tool: string): Event {
  return {
    type: "message.part.updated",
    properties: { part: { sessionID, type: "tool", tool } },
  } as unknown as Event;
}

function idleEvent(sessionID: string): Event {
  return { type: "session.idle", properties: { sessionID } } as unknown as Event;
}

describe("sessionIdOf", () => {
  it("reads the id directly from properties.sessionID", () => {
    expect(sessionIdOf(idleEvent("s1"))).toBe("s1");
  });
  it("reads the id nested under properties.part (message.part.updated)", () => {
    expect(sessionIdOf(partEvent("s2", "profile_source"))).toBe("s2");
  });
  it("reads the id nested under properties.info (message.updated)", () => {
    const ev = {
      type: "message.updated",
      properties: { info: { sessionID: "s3" } },
    } as unknown as Event;
    expect(sessionIdOf(ev)).toBe("s3");
  });
  it("returns undefined for a non-session-scoped event", () => {
    const ev = { type: "server.connected", properties: {} } as unknown as Event;
    expect(sessionIdOf(ev)).toBeUndefined();
  });
});

describe("isProgressEvent", () => {
  it("accepts the streamed progress types", () => {
    expect(isProgressEvent("message.part.updated")).toBe(true);
    expect(isProgressEvent("session.idle")).toBe(true);
    expect(isProgressEvent("session.error")).toBe(true);
  });
  it("rejects noise the UI should not render as progress", () => {
    expect(isProgressEvent("server.connected")).toBe(false);
    expect(isProgressEvent("file.watcher.updated")).toBe(false);
    expect(isProgressEvent("permission.updated")).toBe(false);
  });
});

describe("createRunBridge", () => {
  it("relays a bound session's progress event to its run sink as a valid SSE frame", async () => {
    const src = makeEventStream();
    const bridge = createRunBridge(mockClient(src.stream));
    const frames: string[] = [];
    bridge.bindSession("run_A", "sess_A");
    bridge.subscribe("run_A", (f) => frames.push(f));

    src.push(partEvent("sess_A", "profile_source"));
    await flush();

    expect(frames).toHaveLength(1);
    const frame = frames[0]!;
    expect(frame.startsWith("event: message.part.updated\n")).toBe(true);
    expect(frame.endsWith("\n\n")).toBe(true);
    const dataLine = frame
      .split("\n")
      .find((l) => l.startsWith("data: "))!
      .slice("data: ".length);
    const payload = RunProgressPayloadSchema.parse(JSON.parse(dataLine));
    expect(payload).toEqual({
      runId: "run_A",
      type: "message.part.updated",
      properties: { part: { sessionID: "sess_A", type: "tool", tool: "profile_source" } },
    });

    await bridge.close();
  });

  it("does not relay non-progress event types", async () => {
    const src = makeEventStream();
    const bridge = createRunBridge(mockClient(src.stream));
    const frames: string[] = [];
    bridge.bindSession("run_A", "sess_A");
    bridge.subscribe("run_A", (f) => frames.push(f));

    src.push({ type: "server.connected", properties: { sessionID: "sess_A" } } as unknown as Event);
    await flush();

    expect(frames).toEqual([]);
    await bridge.close();
  });

  it("drops events for a session not bound to any run", async () => {
    const src = makeEventStream();
    const bridge = createRunBridge(mockClient(src.stream));
    const frames: string[] = [];
    bridge.bindSession("run_A", "sess_A");
    bridge.subscribe("run_A", (f) => frames.push(f));

    src.push(idleEvent("sess_UNKNOWN"));
    await flush();

    expect(frames).toEqual([]);
    await bridge.close();
  });

  it("routes each session's events to only its own run", async () => {
    const src = makeEventStream();
    const bridge = createRunBridge(mockClient(src.stream));
    const a: string[] = [];
    const b: string[] = [];
    bridge.bindSession("run_A", "sess_A");
    bridge.bindSession("run_B", "sess_B");
    bridge.subscribe("run_A", (f) => a.push(f));
    bridge.subscribe("run_B", (f) => b.push(f));

    src.push(idleEvent("sess_B"));
    src.push(idleEvent("sess_A"));
    await flush();

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]).toContain('"runId":"run_A"');
    expect(b[0]).toContain('"runId":"run_B"');
    await bridge.close();
  });

  it("stops delivering to a sink after it unsubscribes", async () => {
    const src = makeEventStream();
    const bridge = createRunBridge(mockClient(src.stream));
    const frames: string[] = [];
    bridge.bindSession("run_A", "sess_A");
    const unsubscribe = bridge.subscribe("run_A", (f) => frames.push(f));

    src.push(idleEvent("sess_A"));
    await flush();
    expect(frames).toHaveLength(1);

    unsubscribe();
    src.push(idleEvent("sess_A"));
    await flush();
    expect(frames).toHaveLength(1);

    await bridge.close();
  });

  it("publish() pushes an application frame to a run's subscribers only", async () => {
    const src = makeEventStream();
    const bridge = createRunBridge(mockClient(src.stream));
    const a: string[] = [];
    const b: string[] = [];
    bridge.subscribe("run_A", (f) => a.push(f));
    bridge.subscribe("run_B", (f) => b.push(f));

    bridge.publish("run_A", {
      event: "step.status",
      data: { kind: "step.status", runId: "run_A", name: "land", status: "running" },
    });

    // Only run_A's subscriber receives it, framed as a valid SSE event.
    expect(b).toHaveLength(0);
    expect(a).toHaveLength(1);
    expect(a[0]).toContain("event: step.status\n");
    expect(a[0]).toContain(
      'data: {"kind":"step.status","runId":"run_A","name":"land","status":"running"}',
    );
    expect(a[0]!.endsWith("\n\n")).toBe(true);

    // Publishing to a run with no subscribers is a no-op.
    expect(() => bridge.publish("run_none", { data: {} })).not.toThrow();

    await bridge.close();
  });

  it("observes every raw event via onEvent before progress filtering", async () => {
    const src = makeEventStream();
    const seen: string[] = [];
    const bridge = createRunBridge(mockClient(src.stream), {
      onEvent: (e) => seen.push(e.type),
    });

    src.push({ type: "server.connected", properties: {} } as unknown as Event);
    src.push(idleEvent("sess_A"));
    await flush();

    expect(seen).toEqual(["server.connected", "session.idle"]);
    await bridge.close();
  });

  it("close() is idempotent and does not report an error on abort", async () => {
    const src = makeEventStream();
    let errored = false;
    const bridge = createRunBridge(mockClient(src.stream), {
      onError: () => {
        errored = true;
      },
    });
    await bridge.close();
    await bridge.close();
    await flush();
    expect(errored).toBe(false);
  });
});
