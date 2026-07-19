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
 * The first block asserts the layout renders its persistent sidebar/chat regions while the data
 * panel stays out of the accessible layout until it has content. The second drives the full V2.4
 * chat path end to end: select a session,
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

  it("keeps an empty data panel collapsed and out of the accessible layout", () => {
    const { container } = render(<App />);
    expect(screen.queryByRole("complementary", { name: "Data panel" })).toBeNull();
    expect(container.firstElementChild?.getAttribute("data-data-open")).toBe("false");
  });

  it("keeps the animated data panel beside the two persistent shell regions", () => {
    const { container } = render(<App />);
    const shell = container.firstElementChild;
    expect(shell).toBeTruthy();
    const nav = shell?.querySelector('nav[aria-label="Sessions"]');
    const main = shell?.querySelector('main[aria-label="Chat"]');
    const aside = shell?.querySelector('aside[aria-label="Data panel"]');
    expect(nav).toBeTruthy();
    expect(main).toBeTruthy();
    expect(aside?.getAttribute("aria-hidden")).toBe("true");
    // The panel stays mounted for a smooth slide transition, but consumes a zero-width column.
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

  // The per-session model control (V6.1) mounts with the chat, so the shell now reads the model
  // catalog and the single session too — answer both with the shapes a live runtime returns.
  const CATALOG = {
    default: "opencode/big-pickle",
    providers: [
      {
        id: "opencode",
        name: "OpenCode Zen",
        source: "custom",
        models: [
          {
            ref: "opencode/big-pickle",
            providerID: "opencode",
            modelID: "big-pickle",
            name: "Big Pickle",
            toolcall: true,
            reasoning: true,
            cost: { input: 0, output: 0 },
            free: true,
          },
        ],
      },
    ],
  };

  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = (init?.method ?? "GET").toUpperCase();
        if (method === "POST") return { ok: true, status: 202, json: async () => ({ id: "u1" }) };
        // The model control reads the catalog and the active session.
        if (String(url).includes("/api/models")) {
          return { ok: true, status: 200, json: async () => CATALOG };
        }
        if (/\/api\/sessions\/ses_1$/.test(String(url))) {
          return { ok: true, status: 200, json: async () => ({ ...SESSION, messages: [] }) };
        }
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
    expect(screen.getByText(/build with your data/i)).toBeTruthy();

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

    // The right panel is still absent until a tool delivers actual tabular data.
    expect(screen.queryByRole("complementary", { name: "Data panel" })).toBeNull();
    await act(async () => {
      es!.emit(
        "tool",
        {
          kind: "tool",
          sessionID: "ses_1",
          messageID: "asst_1",
          partID: "tool-1",
          callID: "call-1",
          tool: "run_query",
          status: "completed",
          metadata: {
            result: {
              columns: [{ name: "branches", type: "BIGINT" }],
              rows: [{ branches: 4 }],
              rowCount: 1,
              truncated: false,
            },
          },
        },
        2,
      );
    });

    await waitFor(() =>
      expect(screen.getByRole("complementary", { name: "Data panel" })).toBeTruthy(),
    );
    expect(document.querySelector(".app-shell")?.getAttribute("data-data-open")).toBe("true");
    expect(screen.getByRole("region", { name: "Query result" })).toBeTruthy();
  });
});

describe("App session reopen (V6.2)", () => {
  const SESSION = {
    id: "ses_1",
    title: "Loan review",
    model: "opencode/big-pickle" as string | null,
    createdAt: "2026-07-17T10:00:00Z",
    updatedAt: "2026-07-17T10:00:00Z",
  };

  const CATALOG = {
    default: "opencode/big-pickle",
    providers: [
      {
        id: "opencode",
        name: "OpenCode Zen",
        source: "custom",
        models: [
          {
            ref: "opencode/big-pickle",
            providerID: "opencode",
            modelID: "big-pickle",
            name: "Big Pickle",
            toolcall: true,
            reasoning: true,
            cost: { input: 0, output: 0 },
            free: true,
          },
        ],
      },
    ],
  };

  // The persisted transcript a reopen fetches: a user prompt and an assistant turn whose
  // tool-block history includes a run_query card — the shape V6.2 must reconstruct.
  const HISTORY = [
    { role: "user", id: "u1", content: "which branch has the most loans?", seq: 0 },
    {
      role: "assistant",
      id: "a1",
      seq: 1,
      content: "The north branch, with 12 loans.",
      blocks: [
        { kind: "reasoning", partID: "r1", text: "I will query the loans." },
        {
          kind: "tool",
          callID: "c1",
          tool: "run_query",
          status: "completed",
          input: { sql: "SELECT branch, count(*) FROM loans GROUP BY branch" },
          output: "north 12",
        },
        { kind: "text", partID: "p1", text: "The north branch, with 12 loans." },
      ],
    },
  ];

  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("/api/models")) {
          return { ok: true, status: 200, json: async () => CATALOG };
        }
        // The reopen fetch — return the session WITH its persisted transcript.
        if (/\/api\/sessions\/ses_1$/.test(String(url))) {
          return { ok: true, status: 200, json: async () => ({ ...SESSION, messages: HISTORY }) };
        }
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

  it("rehydrates a session's messages and tool-block history when reopened", async () => {
    render(<App />);

    const sessionButton = await screen.findByRole("button", { name: "Loan review" });
    await act(async () => {
      fireEvent.click(sessionButton);
    });

    // The persisted user prompt and assistant answer reconstruct into the transcript…
    await waitFor(() =>
      expect(screen.getByText("which branch has the most loans?")).toBeTruthy(),
    );
    expect(screen.getByText("The north branch, with 12 loans.")).toBeTruthy();
    // …and the assistant turn's tool card (its tool-block history) is rendered, not just text.
    await waitFor(() => expect(screen.getByText(/run_query/)).toBeTruthy());
  });
});
