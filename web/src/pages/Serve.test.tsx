// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ServePage } from "./Serve";
import type { Project, ServedData, ServedTable } from "../lib/api";

/**
 * Component test for the Serve page (T5.4, FR10). `fetch` is mocked so the test asserts the
 * desired behavior against the real API contract: the page lists what a project published, reads
 * it back through the generated REST endpoint, and renders the endpoint URL, the CSV download,
 * the mini dashboard and the table preview — the "queryable (REST) and downloadable (CSV)"
 * acceptance criterion as a user sees it.
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

function makeServed(over: Partial<ServedTable> = {}): ServedTable {
  return {
    name: "branch_balance_totals",
    projectId: "p-1",
    runId: "r-1",
    schema: "marts",
    table: "branch_balance_totals",
    qualifiedTable: "marts.branch_balance_totals",
    format: "csv",
    rowCount: 2,
    csvPath: "data/serving/p-1/branch_balance_totals.csv",
    endpoint: "/api/serve/branch_balance_totals",
    csvEndpoint: "/api/serve/branch_balance_totals.csv",
    publishedAt: "2026-07-17 10:30:00",
    ...over,
  };
}

function makeData(over: Partial<ServedData> = {}): ServedData {
  const rows = over.rows ?? [
    { branch: "north", total_balance: 1750.75 },
    { branch: "south", total_balance: 0 },
  ];
  return {
    name: "branch_balance_totals",
    schema: "marts",
    table: "branch_balance_totals",
    qualifiedTable: "marts.branch_balance_totals",
    format: "csv",
    endpoint: "/api/serve/branch_balance_totals",
    csvEndpoint: "/api/serve/branch_balance_totals.csv",
    publishedAt: "2026-07-17 10:30:00",
    columns: [
      { name: "branch", type: "VARCHAR" },
      { name: "total_balance", type: "DOUBLE" },
    ],
    rowCount: rows.length,
    rows,
    limit: 100,
    offset: 0,
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

function installFetch(opts: {
  projects?: Project[];
  served?: ServedTable[];
  data?: ServedData;
  dataStatus?: number;
  dataError?: unknown;
}) {
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.endsWith("/served")) {
      return jsonResponse(200, { served: opts.served ?? [] });
    }
    if (url.startsWith("/api/serve/")) {
      return opts.dataStatus && opts.dataStatus >= 400
        ? jsonResponse(opts.dataStatus, opts.dataError)
        : jsonResponse(200, opts.data ?? makeData());
    }
    return jsonResponse(200, { projects: opts.projects ?? [] });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderPage() {
  return render(
    <MemoryRouter>
      <ServePage />
    </MemoryRouter>,
  );
}

describe("serve page", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("prompts to create a project when none exist", async () => {
    installFetch({ projects: [] });
    renderPage();
    expect(await screen.findByText(/create a project first/i)).toBeTruthy();
  });

  it("shows the generated endpoint and a CSV download for the published table", async () => {
    const fetchMock = installFetch({ projects: [makeProject()], served: [makeServed()] });
    renderPage();

    const region = await screen.findByRole("region", { name: /generated endpoints/i });
    await waitFor(() => expect(region.textContent).toContain("GET /api/serve/branch_balance_totals"));
    expect(region.textContent).toContain("marts.branch_balance_totals");

    // The download link points at the generated CSV endpoint and asks the browser to save it.
    const download = screen.getByRole("link", { name: /download csv/i }) as HTMLAnchorElement;
    expect(download.getAttribute("href")).toBe("/api/serve/branch_balance_totals.csv");
    expect(download.hasAttribute("download")).toBe(true);

    // The preview comes from the project's served list and then the real REST endpoint.
    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls).toContain("/api/projects/p-1/served");
    expect(urls).toContain("/api/serve/branch_balance_totals");
  });

  it("previews the served rows in the data table", async () => {
    installFetch({ projects: [makeProject()], served: [makeServed()] });
    renderPage();

    const table = await screen.findByRole("region", { name: /served data/i });
    await waitFor(() => expect(table.textContent).toContain("north"));
    // Values and columns as served — order-independent, since the pipeline guarantees no order.
    expect(table.textContent).toContain("south");
    expect(table.textContent).toContain("1750.75");
    expect(table.textContent).toContain("branch");
    expect(table.textContent).toContain("total_balance");
    expect(table.textContent).toContain("2 rows");
  });

  it("renders the mini dashboard's tiles and measure breakdown", async () => {
    installFetch({ projects: [makeProject()], served: [makeServed()] });
    renderPage();

    const dashboard = await screen.findByRole("region", { name: /report dashboard/i });
    await waitFor(() => expect(dashboard.textContent).toContain("Rows served"));
    expect(dashboard.textContent).toContain("Total total_balance");
    expect(dashboard.textContent).toContain("1,750.75");
    expect(dashboard.textContent).toContain("total_balance by branch");
  });

  it("withholds the chart, with a reason, when the measure has negative values", async () => {
    installFetch({
      projects: [makeProject()],
      served: [makeServed()],
      data: makeData({
        rows: [
          { branch: "north", total_balance: 100 },
          { branch: "south", total_balance: -40 },
        ],
      }),
    });
    renderPage();

    const dashboard = await screen.findByRole("region", { name: /report dashboard/i });
    await waitFor(() => expect(dashboard.textContent).toContain("negative values"));
    // The tiles still report the measure; only the misleading chart is withheld.
    expect(dashboard.textContent).toContain("Total total_balance");
    expect(dashboard.textContent).toContain("60");
    expect(dashboard.textContent).not.toContain("total_balance by branch");
  });

  it("says a project has published nothing yet and links back to Run", async () => {
    installFetch({ projects: [makeProject()], served: [] });
    renderPage();

    expect(await screen.findByText(/has not published a table yet/i)).toBeTruthy();
    expect(screen.getByRole("link", { name: /run the pipeline/i })).toBeTruthy();
    // Nothing to preview, so no endpoint region is claimed.
    expect(screen.queryByRole("region", { name: /generated endpoints/i })).toBeNull();
  });

  it("surfaces the backend's message when the published export is gone", async () => {
    installFetch({
      projects: [makeProject()],
      served: [makeServed()],
      dataStatus: 410,
      dataError: { error: 'the published export for served table "branch_balance_totals" is missing' },
    });
    renderPage();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("missing");
    // The endpoint is still registered, so its URL stays on screen for the reader.
    expect(screen.getByRole("region", { name: /generated endpoints/i })).toBeTruthy();
  });
});
