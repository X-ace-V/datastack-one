// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ConnectPage } from "./Connect";
import type { Project, Source, SourceProfile } from "../lib/api";

/**
 * Component test for the connect-source page (T2.2, FR2). `fetch` is mocked so the test
 * asserts the desired behavior against the real API contract: the page lists projects and
 * their sources on mount, choosing a CSV file posts a multipart body carrying that file to
 * the selected project, and the uploaded source is shown and prepended to the list.
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

function makeSource(over: Partial<Source> = {}): Source {
  return {
    id: "s-1",
    projectId: "p-1",
    kind: "csv",
    path: "data/uploads/p-1/s-1-loans.csv",
    originalFilename: "loans.csv",
    rowCount: null,
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

interface PostCall {
  url: string;
  body: FormData;
}

function installFetch(opts: {
  projects?: Project[];
  sources?: Source[];
  onUpload: () => Response;
  postCalls: PostCall[];
}) {
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "POST") {
      opts.postCalls.push({ url, body: init?.body as FormData });
      return opts.onUpload();
    }
    if (url.endsWith("/sources")) {
      return jsonResponse(200, { sources: opts.sources ?? [] });
    }
    return jsonResponse(200, { projects: opts.projects ?? [] });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderPage() {
  return render(
    <MemoryRouter>
      <ConnectPage />
    </MemoryRouter>,
  );
}

describe("connect-source page", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("prompts to create a project when none exist", async () => {
    installFetch({ projects: [], onUpload: () => jsonResponse(201, makeSource()), postCalls: [] });
    renderPage();
    expect(await screen.findByText(/create a project first/i)).toBeTruthy();
  });

  it("lists a project's existing sources on mount", async () => {
    installFetch({
      projects: [makeProject()],
      sources: [makeSource({ id: "s-old", originalFilename: "history.csv" })],
      onUpload: () => jsonResponse(201, makeSource()),
      postCalls: [],
    });
    renderPage();
    expect(await screen.findByText("history.csv")).toBeTruthy();
  });

  it("uploads a chosen CSV to the selected project and shows it", async () => {
    const postCalls: PostCall[] = [];
    installFetch({
      projects: [makeProject()],
      sources: [],
      onUpload: () => jsonResponse(201, makeSource({ id: "s-new", originalFilename: "loans.csv" })),
      postCalls,
    });
    renderPage();

    // Empty state until a file is uploaded.
    expect(await screen.findByText(/no sources uploaded yet/i)).toBeTruthy();

    const input = screen.getByLabelText(/csv file/i) as HTMLInputElement;
    const file = new File(["customer_id,amount\n1,10\n"], "loans.csv", { type: "text/csv" });
    fireEvent.change(input, { target: { files: [file] } });

    // The success status names the uploaded file and offers the next step.
    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("loans.csv");
    expect(screen.getByRole("link", { name: /continue to plan/i })).toBeTruthy();

    // Exactly one multipart POST to the selected project's upload route, carrying the file.
    expect(postCalls).toHaveLength(1);
    expect(postCalls[0]?.url).toBe("/api/projects/p-1/source");
    expect(postCalls[0]?.body).toBeInstanceOf(FormData);
    const posted = postCalls[0]?.body.get("file") as File;
    expect(posted.name).toBe("loans.csv");

    // The uploaded source is prepended to the list.
    await waitFor(() => {
      const items = screen.getAllByText("loans.csv");
      expect(items.length).toBeGreaterThan(0);
    });
  });

  it("profiles the source and renders the schema table", async () => {
    const profile: SourceProfile = {
      rowCount: 4,
      columnCount: 2,
      columns: [
        {
          name: "loan_id",
          type: "BIGINT",
          nullCount: 0,
          nullPercent: 0,
          distinctCount: 4,
          isCandidateKey: true,
          isDateColumn: false,
        },
        {
          name: "opened_at",
          type: "DATE",
          nullCount: 1,
          nullPercent: 25,
          distinctCount: 3,
          isCandidateKey: false,
          isDateColumn: true,
        },
      ],
      candidateKeys: ["loan_id"],
      dateColumns: ["opened_at"],
    };
    const source = makeSource({ id: "s-1", originalFilename: "loans.csv" });
    const postCalls: PostCall[] = [];
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "POST" && url.endsWith("/profile")) {
        postCalls.push({ url, body: init?.body as FormData });
        return jsonResponse(200, { source: { ...source, rowCount: 4 }, profile });
      }
      if (url.endsWith("/sources")) {
        return jsonResponse(200, { sources: [source] });
      }
      return jsonResponse(200, { projects: [makeProject()] });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();

    const button = await screen.findByRole("button", { name: /profile schema/i });
    fireEvent.click(button);

    // The profile stage was requested for the selected project.
    await waitFor(() => expect(postCalls).toHaveLength(1));
    expect(postCalls[0]?.url).toBe("/api/projects/p-1/profile");

    // The schema table renders the profiled columns, types and the candidate-key flag.
    const table = await screen.findByRole("region", { name: /source profile/i });
    expect(table.textContent).toContain("loan_id");
    expect(table.textContent).toContain("BIGINT");
    expect(table.textContent).toContain("opened_at");
    expect(table.textContent).toContain("DATE");
    expect(table.textContent).toContain("key");
    // The row count is now shown on the source row.
    await waitFor(() => {
      expect(screen.getByText(/4 rows/)).toBeTruthy();
    });
  });

  it("surfaces a backend profile error", async () => {
    const source = makeSource({ id: "s-1", originalFilename: "loans.csv" });
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "POST" && url.endsWith("/profile")) {
        return jsonResponse(422, { error: "could not profile source: bad csv" });
      }
      if (url.endsWith("/sources")) {
        return jsonResponse(200, { sources: [source] });
      }
      return jsonResponse(200, { projects: [makeProject()] });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    const button = await screen.findByRole("button", { name: /profile schema/i });
    fireEvent.click(button);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("could not profile source");
  });

  it("surfaces a backend upload error", async () => {
    installFetch({
      projects: [makeProject()],
      sources: [],
      onUpload: () => jsonResponse(400, { error: "only .csv files are supported" }),
      postCalls: [],
    });
    renderPage();

    const input = (await screen.findByLabelText(/csv file/i)) as HTMLInputElement;
    const file = new File(["x"], "bad.txt", { type: "text/plain" });
    fireEvent.change(input, { target: { files: [file] } });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("only .csv files are supported");
  });
});
