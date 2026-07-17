// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEvents } from "./useEvents";
import { useSessionStore, type NormalizedEvent } from "../store/sessionStore";

/**
 * V2.2 — the chat SSE hook. jsdom has no `EventSource`, so a fake stands in (recorded per the
 * AGENTS lesson): it captures the URL it was opened with, records a listener per named channel,
 * and exposes `emit*` helpers to drive frames, opens, and errors into the hook. The tests prove
 * the hook opens ONE stream on `/api/events`, wires a handler for every event kind, routes each
 * parsed event to the store, tracks the seq cursor, and reconnects with `?lastSeq`.
 */

interface FakeMessage {
  data: string;
  lastEventId: string;
}

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static reset() {
    FakeEventSource.instances = [];
  }
  /** The most recently constructed instance (the current connection). */
  static get latest(): FakeEventSource {
    const last = FakeEventSource.instances.at(-1);
    if (!last) throw new Error("no EventSource was opened");
    return last;
  }

  readonly url: string;
  closed = false;
  private listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, cb: (event: unknown) => void): void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(cb);
  }

  removeEventListener(type: string, cb: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(cb);
  }

  close(): void {
    this.closed = true;
  }

  /** True if any listener is registered on `type` (proves a channel is wired). */
  hasChannel(type: string): boolean {
    return (this.listeners.get(type)?.size ?? 0) > 0;
  }

  private dispatch(type: string, event: unknown): void {
    for (const cb of this.listeners.get(type) ?? []) cb(event);
  }

  emitOpen(): void {
    this.dispatch("open", { type: "open" });
  }

  emitError(): void {
    this.dispatch("error", { type: "error" });
  }

  /** Emit a named-channel frame carrying a JSON event body and its `id:` seq. */
  emit(event: NormalizedEvent, seq: number): void {
    const msg: FakeMessage = { data: JSON.stringify(event), lastEventId: String(seq) };
    this.dispatch(event.kind, msg);
  }

  /** Emit a raw (possibly malformed) frame on a channel without JSON-encoding. */
  emitRaw(channel: string, data: string, seq: number): void {
    this.dispatch(channel, { data, lastEventId: String(seq) } satisfies FakeMessage);
  }
}

beforeEach(() => {
  FakeEventSource.reset();
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const textEvent = (sessionID: string, text: string): NormalizedEvent => ({
  kind: "text",
  sessionID,
  messageID: "m1",
  partID: "p1",
  text,
});

describe("useEvents — connection", () => {
  it("opens exactly one EventSource on /api/events and reports connecting→open", () => {
    const onEvent = vi.fn();
    const { result } = renderHook(() => useEvents({ onEvent }));

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.latest.url).toBe("/api/events");
    expect(result.current.status).toBe("connecting");

    act(() => FakeEventSource.latest.emitOpen());
    expect(result.current.status).toBe("open");
  });

  it("wires a listener for every normalized event kind (named channels)", () => {
    renderHook(() => useEvents({ onEvent: vi.fn() }));
    const es = FakeEventSource.latest;
    for (const channel of [
      "text",
      "reasoning",
      "tool",
      "idle",
      "error",
      "approval",
      "approval_resolved",
    ]) {
      expect(es.hasChannel(channel)).toBe(true);
    }
    // The default `message` channel is intentionally unused — the server names every frame.
    expect(es.hasChannel("message")).toBe(false);
  });

  it("does not open a stream when disabled", () => {
    const { result } = renderHook(() => useEvents({ onEvent: vi.fn(), enabled: false }));
    expect(FakeEventSource.instances).toHaveLength(0);
    expect(result.current.status).toBe("closed");
  });

  it("closes the stream on unmount", () => {
    const { unmount } = renderHook(() => useEvents({ onEvent: vi.fn() }));
    const es = FakeEventSource.latest;
    expect(es.closed).toBe(false);
    unmount();
    expect(es.closed).toBe(true);
  });
});

describe("useEvents — routing", () => {
  it("parses each frame and forwards the normalized event to onEvent", () => {
    const onEvent = vi.fn();
    renderHook(() => useEvents({ onEvent }));
    const es = FakeEventSource.latest;

    const evt = textEvent("ses_1", "hello");
    act(() => es.emit(evt, 1));
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith(evt);
  });

  it("routes every event kind through the same handler", () => {
    const onEvent = vi.fn();
    renderHook(() => useEvents({ onEvent }));
    const es = FakeEventSource.latest;

    const events: NormalizedEvent[] = [
      { kind: "reasoning", sessionID: "s", messageID: "m", partID: "p", text: "why" },
      {
        kind: "tool",
        sessionID: "s",
        messageID: "m",
        partID: "p",
        callID: "c",
        tool: "run_query",
        status: "running",
      },
      { kind: "idle", sessionID: "s" },
      { kind: "error", sessionID: "s", message: "boom" },
      { kind: "approval", sessionID: "s", requestID: "r", type: "run_transform", metadata: {} },
      { kind: "approval_resolved", sessionID: "s", requestID: "r", status: "approved" },
    ];
    act(() => events.forEach((e, i) => es.emit(e, i + 1)));
    expect(onEvent.mock.calls.map((c) => c[0])).toEqual(events);
  });

  it("drops a malformed frame without calling onEvent or throwing", () => {
    const onEvent = vi.fn();
    renderHook(() => useEvents({ onEvent }));
    const es = FakeEventSource.latest;
    act(() => es.emitRaw("text", "{not json", 1));
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("feeds the real session store so the active transcript updates", () => {
    const { result } = renderHook(() => {
      const store = useSessionStore();
      const conn = useEvents({ onEvent: store.handleEvent });
      return { store, conn };
    });

    act(() => result.current.store.setActiveSession("ses_1"));
    act(() => FakeEventSource.latest.emit(textEvent("ses_1", "the answer"), 1));

    const msgs = result.current.store.activeState.messages;
    expect(msgs).toEqual([
      { role: "assistant", id: "m1", blocks: [{ kind: "text", partID: "p1", text: "the answer" }] },
    ]);
  });
});

describe("useEvents — seq tracking & reconnect", () => {
  it("tracks the highest seq from the frame id", () => {
    const { result } = renderHook(() => useEvents({ onEvent: vi.fn() }));
    const es = FakeEventSource.latest;
    act(() => es.emit(textEvent("s", "a"), 3));
    act(() => es.emit(textEvent("s", "b"), 7));
    // A stale/lower seq must not roll the cursor backward.
    act(() => es.emit(textEvent("s", "c"), 5));
    expect(result.current.lastSeq).toBe(7);
  });

  it("reconnects with ?lastSeq after an error, resuming from the last seq seen", async () => {
    const { result } = renderHook(() =>
      useEvents({ onEvent: vi.fn(), reconnectDelayMs: 0 }),
    );
    const first = FakeEventSource.latest;
    act(() => first.emit(textEvent("s", "a"), 5));

    await act(async () => {
      first.emitError();
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(first.closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.latest.url).toBe("/api/events?lastSeq=5");
    expect(result.current.status).toBe("connecting");
  });

  it("reconnects even with no events seen, from the base url", async () => {
    renderHook(() => useEvents({ onEvent: vi.fn(), reconnectDelayMs: 0 }));
    const first = FakeEventSource.latest;
    await act(async () => {
      first.emitError();
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.latest.url).toBe("/api/events");
  });

  it("stops reconnecting once unmounted", async () => {
    const { unmount } = renderHook(() =>
      useEvents({ onEvent: vi.fn(), reconnectDelayMs: 0 }),
    );
    const first = FakeEventSource.latest;
    act(() => first.emitError());
    unmount();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    // No new connection opened after unmount.
    expect(FakeEventSource.instances).toHaveLength(1);
  });
});
