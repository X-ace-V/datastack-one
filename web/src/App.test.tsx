// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { App } from "./App";

/**
 * V0.2/V2.4 — the three-pane agent shell, now wired to the live-state store and SSE stream.
 * The first block asserts the layout still renders its three landmark regions (session sidebar ·
 * chat · data panel). The second drives the full V2.4 chat path end to end: select a session,
 * send a prompt, and stream an assistant text frame back through the REAL useEvents → store →
 * ChatStream → MessageBubble pipeline (only the network transports — fetch + EventSource — are
 * faked, exactly the V2.2/V2.3 boundary).
 */

/** A minimal EventSource stand-in: jsdom has none, and useEvents opens one on mount. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  listeners = new Map<string, ((e: unknown) => void)[]>();
  readyState = 0;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, cb: (e: unknown) => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(cb);
    this.listeners.set(type, list);
  }
  removeEventListener() {}
  close() {
    this.readyState = 2;
  }
  /** Deliver one framed event on a named channel, as the SSE route would. */
  emit(channel: string, data: unknown, seq: number) {
    const frame = { data: JSON.stringify(data), lastEventId: String(seq) };
    for (const cb of this.listeners.get(channel) ?? []) cb(frame);
  }
}

describe("App shell", () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ sessions: [] }),
      })),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders the session sidebar as a named navigation landmark", () => {
    render(<App />);
    const sidebar = screen.getByRole("navigation", { name: "Sessions" });
    expect(sidebar).toBeTruthy();
  });

  it("renders the chat region as a named main landmark", () => {
    render(<App />);
    const chat = screen.getByRole("main", { name: "Chat" });
    expect(chat).toBeTruthy();
  });

  it("renders the data panel as a named complementary landmark", () => {
    render(<App />);
    const panel = screen.getByRole("complementary", { name: "Data panel" });
    expect(panel).toBeTruthy();
  });

  it("renders all three regions as siblings of one shell container", () => {
    const { container } = render(<App />);
    const shell = container.firstElementChild;
    expect(shell).toBeTruthy();
    const nav = shell?.querySelector('nav[aria-label="Sessions"]');
    const main = shell?.querySelector('main[aria-label="Chat"]');
    const aside = shell?.querySelector('aside[aria-label="Data panel"]');
    expect(nav).toBeTruthy();
    expect(main).toBeTruthy();
    expect(aside).toBeTruthy();
    // The three panes are direct children of the same grid container, in reading order.
    expect(nav?.parentElement).toBe(shell);
    expect(main?.parentElement).toBe(shell);
    expect(aside?.parentElement).toBe(shell);
  });
});

describe("App chat flow (V2.4)", () => {
  const SESSION = {
    id: "ses_1",
    title: "Loan review",
    model: "opencode/big-pickle" as string | null,
    createdAt: "2026-07-17T10:00:00Z",
    updatedAt: "2026-07-17T10:00:00Z",
  };

  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = (init?.method ?? "GET").toUpperCase();
        if (method === "POST") return { ok: true, status: 202, json: async () => ({ id: "u1" }) };
        // The data panel's audit-trail view (V4.4) fetches the session's lineage once a session
        // is active — answer it with an empty trail so the shell renders without erroring.
        if (String(url).includes("/lineage")) {
          return { ok: true, status: 200, json: async () => ({ lineage: [] }) };
        }
        return { ok: true, status: 200, json: async () => ({ sessions: [SESSION] }) };
      }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("selects a session, sends a prompt, and streams the assistant reply into a bubble", async () => {
    render(<App />);

    // The sidebar lists the session; before selection the chat pane shows its placeholder.
    const sessionButton = await screen.findByRole("button", { name: "Loan review" });
    expect(screen.getByText(/start a session to chat/i)).toBeTruthy();

    // Selecting the session mounts the composer.
    await act(async () => {
      fireEvent.click(sessionButton);
    });
    const box = await screen.findByLabelText("Message the agent");

    // Send a prompt — the optimistic user bubble appears immediately.
    fireEvent.change(box, { target: { value: "how many branches?" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
    });
    expect(screen.getByText("how many branches?")).toBeTruthy();

    // Stream an assistant text frame back through the real SSE → store pipeline.
    const es = FakeEventSource.instances[0];
    expect(es).toBeTruthy();
    await act(async () => {
      es!.emit(
        "text",
        {
          kind: "text",
          sessionID: "ses_1",
          messageID: "asst_1",
          partID: "p1",
          text: "There are 4 branches.",
        },
        1,
      );
    });

    await waitFor(() => expect(screen.getByText("There are 4 branches.")).toBeTruthy());
  });
});
