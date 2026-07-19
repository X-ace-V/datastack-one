// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { DataPanel } from "./DataPanel";
import { createEmptySessionState, type SessionLiveState } from "../store/sessionStore";

/**
 * Component test for DataPanel (V3.3/V3.4, FR6/FR7/FR12): the right-hand panel renders the latest
 * `profile_source` schema and the latest `run_query` result pulled from the live chat stream, and
 * shows its placeholder until either has run. Asserts the desired behavior end-to-end from a session
 * state, not merely mount.
 */
describe("DataPanel", () => {
  afterEach(cleanup);

  const PROFILE = {
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
        nullCount: 0,
        nullPercent: 0,
        distinctCount: 3,
        isCandidateKey: false,
        isDateColumn: true,
      },
    ],
    candidateKeys: ["loan_id"],
    dateColumns: ["opened_at"],
  };

  function profileBlock() {
    return {
      kind: "tool" as const,
      callID: "p1",
      tool: "profile_source",
      status: "completed" as const,
      metadata: { profile: PROFILE },
    };
  }

  function stateWithProfile(): SessionLiveState {
    return {
      ...createEmptySessionState(),
      messages: [
        { role: "user", id: "u1", content: "profile the loans" },
        { role: "assistant", id: "a1", blocks: [profileBlock()] },
      ],
    };
  }

  function stateWithQuery(): SessionLiveState {
    return {
      ...createEmptySessionState(),
      messages: [
        { role: "user", id: "u1", content: "totals by branch?" },
        {
          role: "assistant",
          id: "a1",
          blocks: [
            {
              kind: "tool",
              callID: "c1",
              tool: "run_query",
              status: "completed",
              metadata: {
                result: {
                  columns: [
                    { name: "branch", type: "VARCHAR" },
                    { name: "total", type: "DOUBLE" },
                  ],
                  rows: [{ branch: "north", total: 1750.75 }],
                  rowCount: 1,
                  truncated: false,
                },
              },
            },
          ],
        },
      ],
    };
  }

  it("stays hidden before any data or audit event exists", () => {
    const { container } = render(<DataPanel state={createEmptySessionState()} />);
    expect(screen.queryByRole("complementary", { name: "Data panel" })).toBeNull();
    expect(container.querySelector('aside[data-open="false"]')).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("renders the latest run_query result as a table", () => {
    render(<DataPanel state={stateWithQuery()} />);
    expect(screen.getByRole("table")).toBeTruthy();
    expect(screen.getByText("north")).toBeTruthy();
    expect(screen.getByText("1750.75")).toBeTruthy();
    expect(screen.getByText("Query result")).toBeTruthy();
    // The placeholder is gone once a result is shown.
    expect(screen.queryByText(/Schema, query results, and endpoints appear here/)).toBeNull();
  });

  it("renders the latest profile_source schema from a tool event", () => {
    render(<DataPanel state={stateWithProfile()} />);
    expect(screen.getByRole("region", { name: "Source profile" })).toBeTruthy();
    expect(screen.getByText("Schema")).toBeTruthy();
    // The profiled columns, their types, and the candidate-key/date flags are shown.
    // (Names appear twice — once in the column table, once in the keys/dates summary.)
    expect(screen.getAllByText("loan_id").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("opened_at").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("BIGINT")).toBeTruthy();
    expect(screen.getByText("key")).toBeTruthy();
    expect(screen.getByText("date")).toBeTruthy();
    expect(screen.queryByText(/Schema, query results, and endpoints appear here/)).toBeNull();
  });

  it("renders both the schema and the query result together", () => {
    const state: SessionLiveState = {
      ...createEmptySessionState(),
      messages: [
        { role: "user", id: "u1", content: "profile then total" },
        {
          role: "assistant",
          id: "a1",
          blocks: [
            profileBlock(),
            {
              kind: "tool",
              callID: "c1",
              tool: "run_query",
              status: "completed",
              metadata: {
                result: {
                  columns: [
                    { name: "branch", type: "VARCHAR" },
                    { name: "total", type: "DOUBLE" },
                  ],
                  rows: [{ branch: "north", total: 1750.75 }],
                  rowCount: 1,
                  truncated: false,
                },
              },
            },
          ],
        },
      ],
    };
    render(<DataPanel state={state} />);
    // Both section headings and both tables are present.
    expect(screen.getByText("Schema")).toBeTruthy();
    expect(screen.getByText("Query result")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Source profile" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Query result" })).toBeTruthy();
    expect(screen.getAllByRole("table")).toHaveLength(2);
    // The schema's column and the query's value both render.
    expect(screen.getAllByText("loan_id").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("north")).toBeTruthy();
  });

  it("renders published endpoints from a publish_serving tool event", () => {
    const state: SessionLiveState = {
      ...createEmptySessionState(),
      messages: [
        { role: "user", id: "u1", content: "publish a branch report" },
        {
          role: "assistant",
          id: "a1",
          blocks: [
            {
              kind: "tool",
              callID: "pub1",
              tool: "publish_serving",
              status: "completed",
              metadata: {
                publish: {
                  name: "branch_report",
                  endpoint: "/api/serve/branch_report",
                  csvEndpoint: "/api/serve/branch_report.csv",
                  rowCount: 4,
                },
              },
            },
          ],
        },
      ],
    };
    render(<DataPanel state={state} />);
    expect(screen.getByText("Endpoints")).toBeTruthy();
    const region = screen.getByRole("region", { name: "Published endpoints" });
    expect(within(region).getByText("branch_report")).toBeTruthy();
    expect(within(region).getByRole("link", { name: "REST" }).getAttribute("href")).toBe(
      "/api/serve/branch_report",
    );
    expect(within(region).getByRole("link", { name: "CSV" }).getAttribute("href")).toBe(
      "/api/serve/branch_report.csv",
    );
    expect(screen.queryByText(/Schema, query results, and endpoints appear here/)).toBeNull();
  });

  it("exposes its landmark and heading only when it has data", () => {
    render(<DataPanel state={stateWithQuery()} />);
    expect(screen.getByRole("complementary", { name: "Data panel" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Workspace data" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /attach|upload|folder/i })).toBeNull();
  });

  it("renders the audit trail section (V4.4) when a session is active", async () => {
    const fetchMock = vi.fn(async (_url: string) => ({
      ok: true,
      status: 200,
      json: async () => ({
        lineage: [
          {
            id: "l1",
            sessionId: "ses_1",
            runId: null,
            seq: 0,
            kind: "tool_call",
            tool: "publish_serving",
            status: "completed",
            detail: { name: "branch_report", rowCount: 4 },
            createdAt: "2026-07-18T10:00:00Z",
          },
        ],
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      render(<DataPanel state={createEmptySessionState()} sessionId="ses_1" />);
      // Persisted lineage is discovered in the background, then reveals the panel and trail.
      const region = await screen.findByRole("region", { name: "Audit trail" });
      expect(region).toBeTruthy();
      expect(screen.getByRole("complementary", { name: "Data panel" })).toBeTruthy();
      await waitFor(() =>
        expect(within(region).getByText("publish_serving")).toBeTruthy(),
      );
      expect(fetchMock.mock.calls[0]?.[0]).toContain("/api/sessions/ses_1/lineage");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
