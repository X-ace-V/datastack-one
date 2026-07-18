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
import { ConnectionsPanel } from "./ConnectionsPanel";
import type { Connection } from "../lib/api";

/**
 * Component test for the Settings → Connections panel (V5.3, FR5). `fetch` is mocked against the
 * real `/api/connections` REST contract (list/create/test/delete) so the wired behaviour is
 * asserted, not merely that it renders: connections are listed, adding one POSTs the exact
 * {name,url} body and CLEARS the URL from the browser, testing calls the test route and shows the
 * scrubbed result, and removing DELETEs and drops the row. The secret is never returned by the API
 * (the list has no url), so the assertion that matters is that the URL leaves local state on add.
 */

const CONNECTIONS: Connection[] = [
  { name: "neon", type: "postgres", createdAt: "2026-07-18T10:00:00Z" },
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

describe("ConnectionsPanel", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("lists registered connections from GET /api/connections", async () => {
    const { fetchMock } = installFetch(() =>
      jsonResponse(200, { connections: CONNECTIONS }),
    );
    render(<ConnectionsPanel onClose={() => {}} />);

    expect(await screen.findByText("neon")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith("/api/connections");
  });

  it("shows an empty state when there are no connections", async () => {
    installFetch(() => jsonResponse(200, { connections: [] }));
    render(<ConnectionsPanel onClose={() => {}} />);

    expect(await screen.findByText(/no connections yet/i)).toBeTruthy();
  });

  it("adds a connection with the exact body and clears the URL from the browser", async () => {
    const added: Connection = {
      name: "reports",
      type: "postgres",
      createdAt: "2026-07-18T11:00:00Z",
    };
    let listed: Connection[] = [];
    const { calls } = installFetch((call) => {
      if (call.method === "POST" && call.url === "/api/connections") {
        listed = [added];
        return jsonResponse(201, { connection: added });
      }
      return jsonResponse(200, { connections: listed });
    });
    render(<ConnectionsPanel onClose={() => {}} />);

    // Wait for the initial (empty) load to settle before interacting.
    await screen.findByText(/no connections yet/i);

    const nameInput = screen.getByLabelText("Connection name");
    const urlInput = screen.getByLabelText("Connection URL") as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "reports" } });
    fireEvent.change(urlInput, {
      target: { value: "postgresql://u:p@host/db?sslmode=require" },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add connection" }));
    });

    // The POST carried exactly the name + URL — the type defaults server-side.
    const post = calls.find((c) => c.method === "POST" && c.url === "/api/connections");
    expect(post?.body).toEqual({
      name: "reports",
      url: "postgresql://u:p@host/db?sslmode=require",
    });

    // The new connection is listed after the refresh…
    await waitFor(() => expect(screen.getByText("reports")).toBeTruthy());
    // …and the secret URL is gone from the browser (input reset) — FR5's core guarantee.
    expect(urlInput.value).toBe("");
  });

  it("tests a connection and shows the scrubbed result", async () => {
    installFetch((call) => {
      if (call.url.endsWith("/test")) {
        return jsonResponse(200, { result: { ok: false, error: "connection refused" } });
      }
      return jsonResponse(200, { connections: CONNECTIONS });
    });
    render(<ConnectionsPanel onClose={() => {}} />);

    const testButton = await screen.findByRole("button", { name: "Test neon" });
    await act(async () => {
      fireEvent.click(testButton);
    });

    await waitFor(() => expect(screen.getByText(/connection refused/i)).toBeTruthy());
  });

  it("removes a connection via DELETE and drops the row", async () => {
    let listed: Connection[] = [...CONNECTIONS];
    const { calls } = installFetch((call) => {
      if (call.method === "DELETE") {
        listed = [];
        return jsonResponse(204, {});
      }
      return jsonResponse(200, { connections: listed });
    });
    render(<ConnectionsPanel onClose={() => {}} />);

    const removeButton = await screen.findByRole("button", { name: "Remove neon" });
    await act(async () => {
      fireEvent.click(removeButton);
    });

    expect(
      calls.some((c) => c.method === "DELETE" && c.url === "/api/connections/neon"),
    ).toBe(true);
    await waitFor(() => expect(screen.queryByText("neon")).toBeNull());
  });

  it("calls onClose from the close button", async () => {
    const onClose = vi.fn();
    installFetch(() => jsonResponse(200, { connections: [] }));
    render(<ConnectionsPanel onClose={onClose} />);
    await screen.findByText(/no connections yet/i);

    fireEvent.click(screen.getByRole("button", { name: "Close connections" }));
    expect(onClose).toHaveBeenCalled();
  });
});
