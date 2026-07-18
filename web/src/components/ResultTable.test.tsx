// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { ResultTable } from "./ResultTable";
import type { QueryResult } from "../lib/query";

/**
 * Component test for ResultTable (V3.3, FR7): the data panel's rendering of a `run_query` result.
 * Asserts the desired render — column headers with types, the exact cell values, a visible dash for
 * a null, right-aligned numeric columns, and the row-count / truncation footer — not merely mount.
 */
describe("ResultTable", () => {
  afterEach(cleanup);

  const RESULT: QueryResult = {
    columns: [
      { name: "branch", type: "VARCHAR" },
      { name: "total", type: "DOUBLE" },
    ],
    rows: [
      { branch: "north", total: 1750.75 },
      { branch: "south", total: null },
    ],
    rowCount: 2,
    truncated: false,
  };

  it("renders the columns, their types, and the cell values", () => {
    render(<ResultTable result={RESULT} />);
    const headers = screen.getAllByRole("columnheader").map((h) => h.textContent);
    expect(headers?.[0]).toContain("branch");
    expect(headers?.[0]).toContain("VARCHAR");
    expect(headers?.[1]).toContain("total");
    expect(screen.getByText("north")).toBeTruthy();
    expect(screen.getByText("1750.75")).toBeTruthy();
  });

  it("shows a dash for a null cell and right-aligns numeric columns", () => {
    const { container } = render(<ResultTable result={RESULT} />);
    expect(screen.getByText("—")).toBeTruthy();
    // The numeric `total` header is right-aligned; the text `branch` header is not.
    const [branchHeader, totalHeader] = screen.getAllByRole("columnheader");
    expect(totalHeader?.className).toContain("text-right");
    expect(branchHeader?.className).not.toContain("text-right");
    expect(container.querySelectorAll("tbody tr")).toHaveLength(2);
  });

  it("reports the row count", () => {
    render(<ResultTable result={RESULT} />);
    expect(screen.getByText("2 rows.")).toBeTruthy();
  });

  it("says the result was truncated when it is", () => {
    render(<ResultTable result={{ ...RESULT, rowCount: 1000, truncated: true }} />);
    expect(screen.getByText(/Showing the first 1,000 rows/)).toBeTruthy();
  });

  it("renders an empty-result message when there are no rows", () => {
    const empty: QueryResult = {
      columns: [{ name: "x", type: "INTEGER" }],
      rows: [],
      rowCount: 0,
      truncated: false,
    };
    render(<ResultTable result={empty} />);
    const body = screen.getByRole("table").querySelector("tbody");
    expect(within(body as HTMLElement).getByText("The query returned no rows.")).toBeTruthy();
  });
});
