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
import { ChatPane } from "./ChatPane";
import { createEmptySessionState, type SessionLiveState } from "../store/sessionStore";

/**
 * Component test for the ChatPane wiring (V2.4, FR2). Asserts the desired behaviour of the
 * send/cancel path against the real `/api/sessions/:id/chat` + `/cancel` contract with a mocked
 * fetch: sending appends the user turn via the store callback and POSTs the exact body, cancelling
 * POSTs to `/cancel`, and a failed send surfaces inline.
 */

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function installFetch(handler: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, method, body });
    return handler({ url, method, body });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls };
}

function stateWith(overrides: Partial<SessionLiveState> = {}): SessionLiveState {
  return { ...createEmptySessionState(), ...overrides };
}

describe("ChatPane", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("appends the user turn and POSTs the chat body on send", async () => {
    const appendUserMessage = vi.fn(() => "u1");
    const { calls } = installFetch(() => jsonResponse(202, { id: "u1" }));
    render(
      <ChatPane sessionId="ses_1" state={stateWith()} appendUserMessage={appendUserMessage} />,
    );

    const box = screen.getByLabelText("Message the agent");
    fireEvent.change(box, { target: { value: "profile the loans" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
    });

    expect(appendUserMessage).toHaveBeenCalledWith("ses_1", "profile the loans");
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    const post = calls.find((c) => c.method === "POST");
    expect(post?.url).toBe("/api/sessions/ses_1/chat");
    expect(post?.body).toEqual({ text: "profile the loans" });
  });

  it("POSTs to /cancel when Cancel is clicked mid-turn", async () => {
    const { calls } = installFetch(() => jsonResponse(200, { status: "cancelled" }));
    render(
      <ChatPane
        sessionId="ses_1"
        state={stateWith({ isWorking: true })}
        appendUserMessage={vi.fn(() => "u1")}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    });

    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    const post = calls.find((c) => c.method === "POST");
    expect(post?.url).toBe("/api/sessions/ses_1/cancel");
  });

  it("surfaces a failed send inline without losing the optimistic user turn", async () => {
    const appendUserMessage = vi.fn(() => "u1");
    installFetch(() => jsonResponse(502, { error: "runtime unavailable" }));
    render(
      <ChatPane sessionId="ses_1" state={stateWith()} appendUserMessage={appendUserMessage} />,
    );

    fireEvent.change(screen.getByLabelText("Message the agent"), {
      target: { value: "build the report" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
    });

    // The optimistic append still happened; the failure is surfaced as an alert.
    expect(appendUserMessage).toHaveBeenCalledWith("ses_1", "build the report");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("runtime unavailable");
  });

  it("prefers the streamed turn error over a stale send error", () => {
    render(
      <ChatPane
        sessionId="ses_1"
        state={stateWith({ error: "model overloaded" })}
        appendUserMessage={vi.fn(() => "u1")}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("model overloaded");
  });
});
