import { describe, expect, it } from "vitest";
import {
  MAX_DASHBOARD_BARS,
  NULL_CATEGORY_LABEL,
  formatMeasure,
  isNumericType,
  pickDimension,
  pickMeasure,
  summarizeServedData,
} from "./dashboard";
import type { ServedCell, ServedData } from "./api";

/**
 * Unit tests for the Serve step's dashboard summarization (T5.4, FR10). They pin the derivations
 * the mini dashboard shows — which columns it picks, what the bars total, and the honesty flags
 * that keep it from implying more than the data supports (a truncated chart, a partial page, a
 * measure it cannot draw proportionally).
 */

function served(over: Partial<ServedData> = {}): ServedData {
  const rows = over.rows ?? [];
  return {
    name: "branch_balance_totals",
    schema: "marts",
    table: "branch_balance_totals",
    qualifiedTable: "marts.branch_balance_totals",
    format: "csv",
    endpoint: "/api/serve/branch_balance_totals",
    csvEndpoint: "/api/serve/branch_balance_totals.csv",
    publishedAt: "2026-07-17 10:00:00",
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

function rows(...pairs: [ServedCell, ServedCell][]): Record<string, ServedCell>[] {
  return pairs.map(([branch, total_balance]) => ({ branch, total_balance }));
}

describe("numeric type detection", () => {
  it("recognizes DuckDB numeric types, including parameterized ones", () => {
    for (const type of ["BIGINT", "DOUBLE", "integer", "DECIMAL(18,2)", "FLOAT", "HUGEINT"]) {
      expect(isNumericType(type), type).toBe(true);
    }
  });

  it("does not treat text, dates or booleans as measurable", () => {
    for (const type of ["VARCHAR", "DATE", "TIMESTAMP", "BOOLEAN", "BLOB", "JSON"]) {
      expect(isNumericType(type), type).toBe(false);
    }
  });
});

describe("column selection", () => {
  it("measures the first numeric column and breaks it down by the first non-numeric one", () => {
    const columns = [
      { name: "branch", type: "VARCHAR" },
      { name: "opened_on", type: "DATE" },
      { name: "loans", type: "BIGINT" },
      { name: "total_balance", type: "DOUBLE" },
    ];
    expect(pickMeasure(columns)).toBe("loans");
    expect(pickDimension(columns)).toBe("branch");
  });

  it("reports no measure or dimension when the report has none of that kind", () => {
    expect(pickMeasure([{ name: "branch", type: "VARCHAR" }])).toBeNull();
    expect(pickDimension([{ name: "total", type: "DOUBLE" }])).toBeNull();
  });
});

describe("served data summary", () => {
  it("summarizes the demo's branch-level report", () => {
    const summary = summarizeServedData(served({ rows: rows(["north", 1750.75], ["south", 0]) }));

    expect(summary).toEqual({
      dimension: "branch",
      measure: "total_balance",
      // Sorted by magnitude — the report itself has no guaranteed order to preserve.
      bars: [
        { label: "north", value: 1750.75 },
        { label: "south", value: 0 },
      ],
      groupCount: 2,
      measureTotal: 1750.75,
      aggregated: false,
      complete: true,
      chartable: true,
    });
  });

  it("sums a category that spans several rows and says it aggregated", () => {
    const summary = summarizeServedData(
      served({ rows: rows(["north", 100], ["south", 40], ["north", 25]) }),
    );

    expect(summary.bars).toEqual([
      { label: "north", value: 125 },
      { label: "south", value: 40 },
    ]);
    expect(summary.aggregated).toBe(true);
    expect(summary.measureTotal).toBe(165);
  });

  it("treats a null measure as no contribution and labels a null category", () => {
    const summary = summarizeServedData(served({ rows: rows(["north", null], [null, 50]) }));

    expect(summary.bars).toEqual([
      { label: NULL_CATEGORY_LABEL, value: 50 },
      { label: "north", value: 0 },
    ]);
    expect(summary.measureTotal).toBe(50);
  });

  it("does not coerce an out-of-safe-range BIGINT string into the total", () => {
    // The backend stringifies a bigint it cannot represent in JSON; summing it would invent a
    // rounded number, so it contributes nothing rather than a wrong value.
    const summary = summarizeServedData(
      served({
        columns: [
          { name: "branch", type: "VARCHAR" },
          { name: "loans", type: "BIGINT" },
        ],
        rows: [
          { branch: "north", loans: "9007199254740993" },
          { branch: "south", loans: 5 },
        ],
      }),
    );

    expect(summary.measure).toBe("loans");
    expect(summary.measureTotal).toBe(5);
    expect(summary.bars).toEqual([
      { label: "south", value: 5 },
      { label: "north", value: 0 },
    ]);
  });

  it("caps the chart at the largest categories and reports how many exist", () => {
    const many: [ServedCell, ServedCell][] = Array.from(
      { length: MAX_DASHBOARD_BARS + 4 },
      (_, i) => [`branch_${i}`, i + 1],
    );
    const summary = summarizeServedData(served({ rows: rows(...many) }));

    expect(summary.bars).toHaveLength(MAX_DASHBOARD_BARS);
    // The largest first, and the truncation is reported rather than silent.
    expect(summary.bars[0]).toEqual({ label: `branch_${many.length - 1}`, value: many.length });
    expect(summary.groupCount).toBe(MAX_DASHBOARD_BARS + 4);
    // Every summarized row still counts toward the total, including the dropped categories.
    expect(summary.measureTotal).toBe((many.length * (many.length + 1)) / 2);
  });

  it("reports an incomplete basis when it summarized only one page", () => {
    const summary = summarizeServedData(
      served({ rows: rows(["north", 10]), rowCount: 250, limit: 100 }),
    );

    expect(summary.complete).toBe(false);
    expect(summary.measureTotal).toBe(10);
  });

  it("refuses to chart a measure with negative values", () => {
    const summary = summarizeServedData(served({ rows: rows(["north", 100], ["south", -40]) }));

    // A bar from a zero baseline would show magnitude and hide the sign.
    expect(summary.chartable).toBe(false);
    expect(summary.bars).toHaveLength(2);
    expect(summary.measureTotal).toBe(60);
  });

  it("refuses to chart an all-zero measure, which has no proportions to draw", () => {
    const summary = summarizeServedData(served({ rows: rows(["north", 0], ["south", 0]) }));

    // Every bar would be zero-length; the tiles and table still report the values.
    expect(summary.chartable).toBe(false);
    expect(summary.bars).toEqual([
      { label: "north", value: 0 },
      { label: "south", value: 0 },
    ]);
  });

  it("handles a report with no numeric column", () => {
    const summary = summarizeServedData(
      served({
        columns: [
          { name: "branch", type: "VARCHAR" },
          { name: "region", type: "VARCHAR" },
        ],
        rows: [{ branch: "north", region: "n1" }],
      }),
    );

    expect(summary).toMatchObject({
      dimension: "branch",
      measure: null,
      bars: [],
      measureTotal: null,
      chartable: false,
    });
  });

  it("handles a report with no categorical column", () => {
    const summary = summarizeServedData(
      served({
        columns: [{ name: "total", type: "DOUBLE" }],
        rows: [{ total: 12 }],
      }),
    );

    expect(summary).toMatchObject({
      dimension: null,
      measure: "total",
      bars: [],
      measureTotal: 12,
      chartable: false,
    });
  });

  it("handles an empty report", () => {
    const summary = summarizeServedData(served({ rows: [] }));

    expect(summary).toMatchObject({
      bars: [],
      groupCount: 0,
      measureTotal: 0,
      chartable: false,
      complete: true,
    });
  });
});

describe("measure formatting", () => {
  it("renders a float sum as a readable number rather than its binary residue", () => {
    expect(formatMeasure(0.1 + 0.2)).toBe("0.3");
    expect(formatMeasure(1750.75)).toBe("1,750.75");
    expect(formatMeasure(0)).toBe("0");
  });
});
