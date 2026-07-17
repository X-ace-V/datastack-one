// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { Sidebar } from "./Sidebar";
import type { Session } from "../lib/api";

/**
 * Component test for the session Sidebar (V2.3, FR1). `fetch` is mocked against the real
 * `/api/sessions` REST contract (list/create/rename/delete) so the full wired behaviour is
 * asserted — the desired result, not merely that it renders: sessions are listed, creating one
 * POSTs and selects it, clicking switches the active session, renaming PATCHes and updates the
 * label, and deleting the active session DELETEs and clears the selection.
 */

const SESSIONS: Session[] = [
  {
    id: "ses_1",
    title: "Loan review",
    model: "opencode/big-pickle",
    createdAt: "2026-07-17T10:00:00Z",
    updatedAt: "2026-07-17T10:00:00Z",
  },
  {
    id: "ses_2",
    title: "Branch report",
    model: null,
    createdAt: "2026-07-16T09:00:00Z",
    updatedAt: "2026-07-16T09:00:00Z",
  },
];

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

/**
 * Install a fetch mock that routes by (url, method) through `handler`, recording every call so a
 * test can assert the exact request shape. The handler returns the Response for that request.
 */
function installFetch(handler: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    const call: Call = { url, method, body };
    calls.push(call);
    return handler(call);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, calls };
}

describe("Sidebar", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("lists sessions from GET /api/sessions", async () => {
    const { fetchMock } = installFetch(() => jsonResponse(200, { sessions: SESSIONS }));
    render(<Sidebar activeSessionId={null} onSelectSession={() => {}} />);

    expect(await screen.findByText("Loan review")).toBeTruthy();
    expect(screen.getByText("Branch report")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith("/api/sessions");
  });

  it("shows an empty state when there are no sessions", async () => {
    installFetch(() => jsonResponse(200, { sessions: [] }));
    render(<Sidebar activeSessionId={null} onSelectSession={() => {}} />);

    expect(await screen.findByText(/no sessions yet/i)).toBeTruthy();
  });

  it("creates a session, prepends it, and selects it", async () => {
    const onSelectSession = vi.fn();
    const created: Session = {
      id: "ses_new",
      title: "New session",
      model: null,
      createdAt: "2026-07-17T11:00:00Z",
      updatedAt: "2026-07-17T11:00:00Z",
    };
    const { calls } = installFetch((call) =>
      call.method === "POST"
        ? jsonResponse(201, created)
        : jsonResponse(200, { sessions: [] }),
    );
    render(<Sidebar activeSessionId={null} onSelectSession={onSelectSession} />);

    await screen.findByText(/no sessions yet/i);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /new session/i }));
    });

    // Scope to the list: the header's "New session" button shares the default title text.
    await waitFor(() =>
      expect(within(screen.getByRole("list")).getByText("New session")).toBeTruthy(),
    );
    const post = calls.find((c) => c.method === "POST");
    expect(post?.url).toBe("/api/sessions");
    // The newly created session becomes the active one.
    expect(onSelectSession).toHaveBeenCalledWith("ses_new");
  });

  it("switches the active session on click and marks it current", async () => {
    const onSelectSession = vi.fn();
    installFetch(() => jsonResponse(200, { sessions: SESSIONS }));
    render(<Sidebar activeSessionId="ses_1" onSelectSession={onSelectSession} />);

    const active = await screen.findByRole("button", { name: "Loan review" });
    // The active session is marked so the shell/chat can follow it.
    expect(active.getAttribute("aria-current")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Branch report" }));
    expect(onSelectSession).toHaveBeenCalledWith("ses_2");
  });

  it("renames a session via PATCH and updates the displayed title", async () => {
    const renamed: Session = {
      id: "ses_1",
      title: "Overdue analysis",
      model: "opencode/big-pickle",
      createdAt: "2026-07-17T10:00:00Z",
      updatedAt: "2026-07-17T12:00:00Z",
    };
    const { calls } = installFetch((call) =>
      call.method === "PATCH"
        ? jsonResponse(200, renamed)
        : jsonResponse(200, { sessions: SESSIONS }),
    );
    render(<Sidebar activeSessionId={null} onSelectSession={() => {}} />);

    await screen.findByText("Loan review");
    fireEvent.click(screen.getByRole("button", { name: "Rename Loan review" }));

    const input = screen.getByLabelText("Session title") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Overdue analysis" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });

    await waitFor(() => expect(screen.getByText("Overdue analysis")).toBeTruthy());
    expect(screen.queryByText("Loan review")).toBeNull();
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.url).toBe("/api/sessions/ses_1");
    expect(patch?.body).toEqual({ title: "Overdue analysis" });
  });

  it("deletes the active session via DELETE and clears the selection", async () => {
    const onSelectSession = vi.fn();
    const { calls } = installFetch((call) =>
      call.method === "DELETE"
        ? jsonResponse(204, undefined)
        : jsonResponse(200, { sessions: SESSIONS }),
    );
    render(<Sidebar activeSessionId="ses_1" onSelectSession={onSelectSession} />);

    await screen.findByText("Loan review");
    // Delete asks for confirmation before it fires (it is not reversible).
    fireEvent.click(screen.getByRole("button", { name: "Delete Loan review" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm delete Loan review" }));
    });

    await waitFor(() => expect(screen.queryByText("Loan review")).toBeNull());
    expect(screen.getByText("Branch report")).toBeTruthy();
    const del = calls.find((c) => c.method === "DELETE");
    expect(del?.url).toBe("/api/sessions/ses_1");
    // The active session no longer exists, so the selection is cleared.
    expect(onSelectSession).toHaveBeenCalledWith(null);
  });

  it("cancels a pending delete without calling the API", async () => {
    const { calls } = installFetch(() => jsonResponse(200, { sessions: SESSIONS }));
    render(<Sidebar activeSessionId={null} onSelectSession={() => {}} />);

    await screen.findByText("Loan review");
    fireEvent.click(screen.getByRole("button", { name: "Delete Loan review" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel delete Loan review" }));

    // Back to the plain row controls, and nothing was deleted.
    expect(screen.getByRole("button", { name: "Delete Loan review" })).toBeTruthy();
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("surfaces a load error instead of a silent empty list", async () => {
    installFetch(() => jsonResponse(503, { error: "session manager unavailable" }));
    render(<Sidebar activeSessionId={null} onSelectSession={() => {}} />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("session manager unavailable");
  });

  it("scopes rename/delete controls to their own session row", async () => {
    installFetch(() => jsonResponse(200, { sessions: SESSIONS }));
    render(<Sidebar activeSessionId={null} onSelectSession={() => {}} />);

    await screen.findByText("Loan review");
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    const [first, second] = rows as [HTMLElement, HTMLElement];
    // Each row carries its own rename/delete pair, named after that session.
    expect(within(first).getByRole("button", { name: "Rename Loan review" })).toBeTruthy();
    expect(within(second).getByRole("button", { name: "Delete Branch report" })).toBeTruthy();
  });
});
