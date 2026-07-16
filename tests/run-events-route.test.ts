import { describe, it, expect, afterAll } from "vitest";
import { buildServer } from "../server/app.js";
import type { FrameSink, RunBridge } from "../server/opencode/bridge.js";
import { formatSseFrame } from "../server/core/events.js";

/**
 * Route-level tests for `GET /api/runs/:runId/events` (T1.3 / FR9). One path is checked
 * via `app.inject` (503 when no bridge is wired). The streaming path is exercised over a
 * real TCP socket with `app.listen` + `fetch`, because SSE is a long-lived response that
 * `inject` would buffer forever — we assert the real `text/event-stream` headers, that a
 * frame the bridge emits arrives on the wire, and that a client disconnect unsubscribes.
 * The bridge's own event routing is covered by server/opencode/bridge.test.ts.
 */

/** A hand-built bridge that lets a test push frames to a run and observe unsubscribe. */
function fakeBridge() {
  const sinks = new Map<string, Set<FrameSink>>();
  let unsubscribed = 0;
  const bridge: RunBridge = {
    bindSession() {},
    subscribe(runId, sink) {
      let set = sinks.get(runId);
      if (!set) {
        set = new Set();
        sinks.set(runId, set);
      }
      set.add(sink);
      return () => {
        set!.delete(sink);
        unsubscribed += 1;
      };
    },
    async close() {},
  };
  return {
    bridge,
    emit(runId: string, frame: string) {
      for (const sink of sinks.get(runId) ?? []) sink(frame);
    },
    subscriberCount(runId: string) {
      return sinks.get(runId)?.size ?? 0;
    },
    unsubscribes() {
      return unsubscribed;
    },
  };
}

describe("GET /api/runs/:runId/events", () => {
  const noBridge = buildServer();

  afterAll(async () => {
    await noBridge.close();
  });

  it("returns 503 when no run-event bridge is wired", async () => {
    const res = await noBridge.inject({ method: "GET", url: "/api/runs/run_1/events" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "run event stream unavailable" });
  });

  it("streams SSE frames over a real socket and unsubscribes on disconnect", async () => {
    const harness = fakeBridge();
    const app = buildServer({ bridge: harness.bridge });
    const address = await app.listen({ port: 0, host: "127.0.0.1" });

    try {
      const controller = new AbortController();
      const res = await fetch(`${address}/api/runs/run_42/events`, {
        headers: { accept: "text/event-stream" },
        signal: controller.signal,
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/event-stream");
      expect(res.headers.get("cache-control")).toContain("no-cache");

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();

      // The route flushes an initial ": connected" comment; read past it.
      let buffered = "";
      const readUntil = async (needle: string): Promise<string> => {
        while (!buffered.includes(needle)) {
          const { value, done } = await reader.read();
          if (done) throw new Error(`stream ended before seeing ${needle}`);
          buffered += decoder.decode(value, { stream: true });
        }
        return buffered;
      };

      await readUntil(": connected");
      expect(harness.subscriberCount("run_42")).toBe(1);

      // Emit a real frame through the bridge and observe it arrive on the wire.
      const frame = formatSseFrame({
        event: "session.idle",
        data: { runId: "run_42", type: "session.idle", properties: { sessionID: "s1" } },
      });
      harness.emit("run_42", frame);
      const got = await readUntil("event: session.idle");
      expect(got).toContain('data: {"runId":"run_42"');

      // Client disconnects → the route must unsubscribe so the bridge drops the sink.
      await reader.cancel();
      controller.abort();

      // Give the server's 'close' handler a tick to run.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(harness.unsubscribes()).toBe(1);
      expect(harness.subscriberCount("run_42")).toBe(0);
    } finally {
      await app.close();
    }
  });
});
