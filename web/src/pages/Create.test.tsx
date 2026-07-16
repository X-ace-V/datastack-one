// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { CreatePage } from "./Create";
import type { Project } from "../lib/api";

/**
 * Component test for the create-project page (T2.1, FR1). `fetch` is mocked so the test
 * asserts the desired behavior against the real API contract: the page lists projects on
 * mount, a submit posts exactly the entered fields, the created project is shown and added
 * to the list, and a failed create surfaces the backend error.
 */

function makeProject(over: Partial<Project> = {}): Project {
  return {
    id: "p-1",
    name: "Loan Book",
    domain: "lending",
    expectedVolume: null,
    warehouse: "duckdb",
    servingStyle: null,
    createdAt: "2026-07-17 00:00:00",
    ...over,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

/** Record POST calls so a test can assert the exact request body sent. */
interface PostCall {
  url: string;
  body: unknown;
}

function installFetch(opts: {
  initialList?: Project[];
  onPost: (body: unknown) => Response;
  postCalls: PostCall[];
}) {
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "POST") {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      opts.postCalls.push({ url, body });
      return opts.onPost(body);
    }
    return jsonResponse(200, { projects: opts.initialList ?? [] });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderPage() {
  return render(
    <MemoryRouter>
      <CreatePage />
    </MemoryRouter>,
  );
}

describe("create-project page", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("lists existing projects fetched on mount", async () => {
    installFetch({
      initialList: [makeProject({ id: "a", name: "Ledger", domain: "finance" })],
      onPost: () => jsonResponse(201, makeProject()),
      postCalls: [],
    });
    renderPage();

    expect(await screen.findByText("Ledger")).toBeTruthy();
    expect(screen.getByText(/finance/)).toBeTruthy();
  });

  it("posts the entered fields and shows the created project", async () => {
    const postCalls: PostCall[] = [];
    installFetch({
      initialList: [],
      onPost: (body) =>
        jsonResponse(201, makeProject({ id: "new-id", name: (body as { name: string }).name })),
      postCalls,
    });
    renderPage();

    // Empty state before any project exists.
    expect(await screen.findByText(/no projects yet/i)).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/project name/i), {
      target: { value: "Loan Book" },
    });
    fireEvent.change(screen.getByLabelText(/business domain/i), {
      target: { value: "lending" },
    });
    fireEvent.change(screen.getByLabelText(/expected volume/i), {
      target: { value: "10M rows/day" },
    });
    fireEvent.submit(screen.getByRole("form", { name: /create project/i }));

    // The success status names the created project and offers the next step.
    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("Loan Book");
    expect(screen.getByRole("link", { name: /continue to connect/i })).toBeTruthy();

    // Exactly the entered fields were posted (empty optionals omitted, not sent as "").
    expect(postCalls).toHaveLength(1);
    expect(postCalls[0]!.url).toBe("/api/projects");
    expect(postCalls[0]!.body).toEqual({
      name: "Loan Book",
      domain: "lending",
      expectedVolume: "10M rows/day",
    });

    // The new project joined the list.
    const list = screen.getByRole("region", { name: /existing projects/i });
    expect(list.textContent).toContain("Loan Book");
  });

  it("surfaces the backend error when create fails", async () => {
    installFetch({
      initialList: [],
      onPost: () => jsonResponse(400, { error: "invalid project" }),
      postCalls: [],
    });
    renderPage();

    fireEvent.change(await screen.findByLabelText(/project name/i), {
      target: { value: "Bad" },
    });
    fireEvent.change(screen.getByLabelText(/business domain/i), {
      target: { value: "lending" },
    });
    fireEvent.submit(screen.getByRole("form", { name: /create project/i }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("invalid project");
    // No success status on failure.
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("keeps submit disabled until name and domain are provided", async () => {
    installFetch({ initialList: [], onPost: () => jsonResponse(201, makeProject()), postCalls: [] });
    renderPage();

    const button = await screen.findByRole("button", { name: /create project/i });
    expect((button as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(/project name/i), { target: { value: "X" } });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/business domain/i), { target: { value: "y" } });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  });
});
