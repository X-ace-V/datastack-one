// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { RunDetailPage } from "./RunDetail";
import type { RunLineage } from "../lib/api";

/**
 * Component tests for the run detail view (T5.5, FR12). `fetch` is mocked so the page is driven
 * against the real `GET /api/runs/:runId/lineage` contract. These assert the four records actually
 * render with their values — and the honesty rules the view promises: unrecorded args must not read
 * as empty args, and an empty record must say so rather than render a blank region.
 */

const LINEAGE: RunLineage = {
  run: {
    id: "run-1",
    projectId: "p-1",
    status: "success",
    model: "opencode/big-pickle",
    createdAt: "2026-07-17 10:00:00",
    updatedAt: "2026-07-17 10:00:09",
  },
  steps: [
    {
      id: "st-1",
      runId: "run-1",
      name: "extract",
      ordinal: 0,
      status: "success",
      detail: "read 3 rows from loans.csv",
      startedAt: "2026-07-17 10:00:00",
      finishedAt: "2026-07-17 10:00:01",
    },
    {
      id: "st-2",
      runId: "run-1",
      name: "transform",
      ordinal: 1,
      status: "success",
      detail: "materialized 2 rows → marts.branch_totals",
      startedAt: "2026-07-17 10:00:01",
      finishedAt: "2026-07-17 10:00:02",
    },
  ],
  toolCalls: [
    {
      id: "tc-1",
      runId: "run-1",
      stepId: "st-2",
      tool: "run_transform",
      args: { targetTable: "branch_totals" },
      status: "success",
      result: "materialized 2 rows → marts.branch_totals",
      error: null,
      startedAt: "2026-07-17 10:00:01",
      finishedAt: "2026-07-17 10:00:02",
    },
  ],
  approvals: [
    {
      id: "ap-1",
      runId: "run-1",
      requestId: "req-1",
      tool: "run_transform",
      args: { targetTable: "branch_totals" },
      action: "approve",
      createdAt: "2026-07-17 10:00:01",
      decidedAt: "2026-07-17 10:00:01",
    },
  ],
  dqResults: [
    {
      id: "dq-1",
      runId: "run-1",
      checkName: "rows present",
      passed: true,
      detail: "3 rows",
      createdAt: "2026-07-17 10:00:03",
    },
  ],
};

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function installFetch(response: () => Response) {
  // The `input` param is declared so the recorded calls carry the requested URL for assertion.
  const fetchMock = vi.fn(async (_input: unknown) => response());
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderPage(runId = "run-1") {
  return render(
    <MemoryRouter initialEntries={[`/runs/${runId}`]}>
      <Routes>
        <Route path="/runs/:runId" element={<RunDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("run detail page", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("requests the lineage of the run in the URL", async () => {
    const fetchMock = installFetch(() => jsonResponse(200, LINEAGE));
    renderPage("run-42");
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("/api/runs/run-42/lineage");
  });

  it("renders the run summary with its status and model", async () => {
    installFetch(() => jsonResponse(200, LINEAGE));
    renderPage();

    const summary = await screen.findByRole("region", { name: /run summary/i });
    await waitFor(() => expect(summary.textContent).toContain("run-1"));
    expect(summary.textContent).toContain("Success");
    expect(summary.textContent).toContain("opencode/big-pickle");
  });

  it("renders each recorded step, tool call, approval, and DQ result", async () => {
    installFetch(() => jsonResponse(200, LINEAGE));
    renderPage();

    // Steps — rendered through the shared stepper, so the stage labels show.
    const steps = await screen.findByRole("region", { name: /^steps$/i });
    await waitFor(() => expect(steps.textContent).toContain("Extract"));
    expect(steps.textContent).toContain("Transform");

    // Tool calls — the tool, its outcome, and the exact args it ran with (FR12).
    const tools = screen.getByRole("region", { name: /tool calls/i });
    expect(tools.textContent).toContain("run_transform");
    expect(tools.textContent).toContain("materialized 2 rows → marts.branch_totals");
    expect(tools.textContent).toContain("branch_totals");

    // Approvals — the FR8 audit trail.
    const approvals = screen.getByRole("region", { name: /approvals/i });
    expect(approvals.textContent).toContain("run_transform");
    expect(approvals.textContent).toContain("Approved");

    // DQ results — the FR7 record.
    const dq = screen.getByRole("region", { name: /data quality/i });
    expect(dq.textContent).toContain("rows present");
    expect(dq.textContent).toContain("Passed");
    expect(dq.textContent).toContain("3 rows");
  });

  it("shows a failed tool call's error rather than a result", async () => {
    installFetch(() =>
      jsonResponse(200, {
        ...LINEAGE,
        toolCalls: [
          {
            ...LINEAGE.toolCalls[0],
            status: "failed",
            result: null,
            error: "Table with name never_created does not exist!",
          },
        ],
      }),
    );
    renderPage();

    const tools = await screen.findByRole("region", { name: /tool calls/i });
    await waitFor(() => expect(tools.textContent).toContain("Failed"));
    expect(tools.textContent).toContain("Table with name never_created does not exist!");
  });

  it("reports which checks failed and that publish was blocked", async () => {
    installFetch(() =>
      jsonResponse(200, {
        ...LINEAGE,
        run: { ...LINEAGE.run, status: "failed" },
        dqResults: [
          LINEAGE.dqResults[0],
          {
            id: "dq-2",
            runId: "run-1",
            checkName: "balance not null",
            passed: false,
            detail: "1 NULL in balance",
            createdAt: "2026-07-17 10:00:03",
          },
        ],
      }),
    );
    renderPage();

    const dq = await screen.findByRole("region", { name: /data quality/i });
    await waitFor(() => expect(dq.textContent).toContain("balance not null"));
    expect(dq.textContent).toContain("Failed");
    expect(dq.textContent).toContain("1 NULL in balance");
    // The view names the FR7 consequence rather than leaving the reader to infer it.
    expect(dq.textContent).toMatch(/1 of 2 checks failed — publish was blocked/i);
  });

  it("says args were not recorded instead of showing an empty arg map", async () => {
    installFetch(() =>
      jsonResponse(200, {
        ...LINEAGE,
        toolCalls: [{ ...LINEAGE.toolCalls[0], args: null }],
      }),
    );
    renderPage();

    const tools = await screen.findByRole("region", { name: /tool calls/i });
    await waitFor(() => expect(tools.textContent).toMatch(/args not recorded/i));
    // `null` args must never render as `{}` — that would claim the tool ran with no arguments.
    expect(tools.textContent).not.toContain("{}");
  });

  it("states plainly when a run recorded nothing rather than rendering empty regions", async () => {
    installFetch(() =>
      jsonResponse(200, { ...LINEAGE, toolCalls: [], approvals: [], dqResults: [] }),
    );
    renderPage();

    const tools = await screen.findByRole("region", { name: /tool calls/i });
    await waitFor(() => expect(tools.textContent).toMatch(/executed no tools/i));
    expect(screen.getByRole("region", { name: /approvals/i }).textContent).toMatch(
      /no approval was decided/i,
    );
    expect(screen.getByRole("region", { name: /data quality/i }).textContent).toMatch(
      /no data-quality results/i,
    );
  });

  it("surfaces a load error with a way back", async () => {
    installFetch(() => jsonResponse(404, { error: "run not found" }));
    renderPage("gone");

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("run not found");
    expect(screen.getByRole("link", { name: /back to run/i })).toBeTruthy();
  });
});
