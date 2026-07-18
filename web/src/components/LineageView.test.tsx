// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { LineageView } from "./LineageView";
import type { LineageEvent } from "../lib/api";

/**
 * Component test for LineageView (V4.4, FR12): the audit-trail section fetches a session's persisted
 * lineage from `GET /api/sessions/:id/lineage` and renders each event with its kind, tool, status
 * badge and a one-line detail summary. Asserts the rendered result, the empty state, the error path,
 * and that changing `refreshKey` refetches — not merely that it mounts.
 */
describe("LineageView", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  function stubLineage(events: LineageEvent[]) {
    const fetchMock = vi.fn(async (_url: string) => ({
      ok: true,
      status: 200,
      json: async () => ({ lineage: events }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  const APPROVAL: LineageEvent = {
    id: "l0",
    sessionId: "ses_1",
    runId: null,
    seq: 0,
    kind: "approval",
    tool: "run_transform",
    status: "approved",
    detail: { metadata: { summary: "Run transform SQL into marts.branch_report." } },
    createdAt: "2026-07-18T10:00:00Z",
  };
  const TOOL_CALL: LineageEvent = {
    id: "l1",
    sessionId: "ses_1",
    runId: null,
    seq: 1,
    kind: "tool_call",
    tool: "run_transform",
    status: "completed",
    detail: { qualifiedTable: "marts.branch_report", rowCount: 4 },
    createdAt: "2026-07-18T10:00:01Z",
  };
  const DQ_FAIL: LineageEvent = {
    id: "l2",
    sessionId: "ses_1",
    runId: null,
    seq: 2,
    kind: "dq_result",
    tool: "run_dq_check",
    status: "failed",
    detail: { results: [{ passed: true }, { passed: false }, { passed: true }] },
    createdAt: "2026-07-18T10:00:02Z",
  };

  it("renders each lineage event with its tool, status badge, and detail summary", async () => {
    stubLineage([APPROVAL, TOOL_CALL, DQ_FAIL]);
    render(<LineageView sessionId="ses_1" />);

    // Two run_transform rows (approval + tool_call) and one run_dq_check row.
    await waitFor(() => expect(screen.getAllByText("run_transform")).toHaveLength(2));
    expect(screen.getByText("run_dq_check")).toBeTruthy();

    // Status badges.
    expect(screen.getByText("Approved")).toBeTruthy();
    expect(screen.getByText("Completed")).toBeTruthy();
    expect(screen.getByText("Failed")).toBeTruthy();

    // Detail summaries: the tool_call names its target + row count, the DQ names failed count.
    expect(screen.getByText(/marts\.branch_report · 4 rows/)).toBeTruthy();
    expect(screen.getByText("3 check(s), 1 failed")).toBeTruthy();
    // The approval carries the reviewed summary.
    expect(screen.getByText(/Run transform SQL into marts\.branch_report/)).toBeTruthy();

    // Ordered list in seq order with the kind data attributes for assertions.
    const items = screen.getAllByRole("listitem");
    expect(items.map((li) => li.getAttribute("data-kind"))).toEqual([
      "approval",
      "tool_call",
      "dq_result",
    ]);
  });

  it("shows an empty-state message when the trail is empty", async () => {
    stubLineage([]);
    render(<LineageView sessionId="ses_1" />);
    await waitFor(() =>
      expect(
        screen.getByText(/Write tool calls, approvals, and data-quality checks appear here/),
      ).toBeTruthy(),
    );
    expect(screen.queryByRole("listitem")).toBeNull();
  });

  it("surfaces a fetch error as an alert", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 500,
        json: async () => ({ error: "boom" }),
        text: async () => "boom",
      })),
    );
    render(<LineageView sessionId="ses_1" />);
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
  });

  it("refetches when refreshKey changes", async () => {
    const fetchMock = stubLineage([TOOL_CALL]);
    const { rerender } = render(<LineageView sessionId="ses_1" refreshKey="0" />);
    await waitFor(() => expect(screen.getByText("run_transform")).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(1);

    rerender(<LineageView sessionId="ses_1" refreshKey="1" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[0]?.[0]).toContain("/api/sessions/ses_1/lineage");
  });
});
