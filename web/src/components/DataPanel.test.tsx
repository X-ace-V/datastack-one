// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { DataPanel } from "./DataPanel";
import { createEmptySessionState, type SessionLiveState } from "../store/sessionStore";

/**
 * Component test for DataPanel (V3.3, FR7/FR12): the right-hand panel renders the latest
 * `run_query` result pulled from the live chat stream, and shows its placeholder until a query has
 * run. Asserts the desired behavior end-to-end from a session state, not merely mount.
 */
describe("DataPanel", () => {
  afterEach(cleanup);

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

  it("shows the placeholder before any query has run", () => {
    render(<DataPanel state={createEmptySessionState()} />);
    expect(screen.getByText(/Schema, query results, and endpoints appear here/)).toBeTruthy();
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

  it("keeps its Data panel landmark and heading", () => {
    render(<DataPanel state={createEmptySessionState()} />);
    expect(screen.getByRole("complementary", { name: "Data panel" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Data" })).toBeTruthy();
  });
});
