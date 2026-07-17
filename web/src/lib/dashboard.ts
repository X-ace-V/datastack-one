import type { ServedCell, ServedColumn, ServedData } from "./api";

/**
 * Pure summarization behind the Serve step's mini dashboard (FR10: "a simple dashboard view of
 * the final report"). It turns a page of served data into the few numbers the dashboard shows —
 * a measure total and a magnitude-by-category breakdown — without knowing anything about the
 * report's subject, since the transform (and therefore the report's shape) is generated per
 * project rather than fixed.
 *
 * Kept free of React so every derivation below is unit-testable on its own. The guiding rule is
 * that the dashboard must never imply more than the data supports: it reports the basis it
 * summarized ({@link ServedSummary.complete}), whether it aggregated anything
 * ({@link ServedSummary.aggregated}), how many categories it left out
 * ({@link ServedSummary.groupCount}), and refuses to draw proportional bars it cannot draw
 * honestly ({@link ServedSummary.chartable}).
 */

/**
 * Categories the dashboard draws before it truncates. A bar chart stops being readable long
 * before a table does, and the full report is always one region away in the `DataTable` — so the
 * chart shows the largest few and says how many it dropped.
 */
export const MAX_DASHBOARD_BARS = 8;

/** Label used for a category whose dimension value is null in the report. */
export const NULL_CATEGORY_LABEL = "(none)";

/** One category's bar: the dimension value and its measure. */
export interface DashboardBar {
  /** The dimension value this bar aggregates. */
  label: string;
  /** The bar's measure — the sum of the measure column across the category's rows. */
  value: number;
}

/** What the mini dashboard renders for one served table. */
export interface ServedSummary {
  /** Column the report is broken down by, or `null` when it has no categorical column. */
  dimension: string | null;
  /** Numeric column being measured, or `null` when the report has no numeric column. */
  measure: string | null;
  /** The largest categories, descending, capped at {@link MAX_DASHBOARD_BARS}. */
  bars: DashboardBar[];
  /** Categories found before the cap — greater than `bars.length` means the chart truncated. */
  groupCount: number;
  /** Sum of the measure across the summarized rows, or `null` without a measure column. */
  measureTotal: number | null;
  /** Whether any category summed more than one row (so its bar is a total, not a value). */
  aggregated: boolean;
  /** Whether the summarized rows are the whole report rather than one page of it. */
  complete: boolean;
  /** Whether the bars can be drawn proportionally — see {@link summarizeServedData}. */
  chartable: boolean;
}

/**
 * DuckDB numeric type names, as `DESCRIBE` reports them for the published export. Matched on the
 * base name so a parameterized type (`DECIMAL(18,2)`) is recognized.
 */
const NUMERIC_TYPES = new Set([
  "TINYINT",
  "SMALLINT",
  "INTEGER",
  "BIGINT",
  "HUGEINT",
  "UTINYINT",
  "USMALLINT",
  "UINTEGER",
  "UBIGINT",
  "UHUGEINT",
  "FLOAT",
  "REAL",
  "DOUBLE",
  "DECIMAL",
  "NUMERIC",
]);

/** Whether a DuckDB column type holds a number the dashboard can measure. */
export function isNumericType(type: string): boolean {
  const base = type.trim().toUpperCase().split("(")[0]?.trim() ?? "";
  return NUMERIC_TYPES.has(base);
}

/** The column the dashboard measures: the report's first numeric column, if it has one. */
export function pickMeasure(columns: ServedColumn[]): string | null {
  return columns.find((column) => isNumericType(column.type))?.name ?? null;
}

/**
 * The column the dashboard breaks the measure down by: the report's first non-numeric column.
 * A generated report is typically `<dimension>, <measure…>` (the demo's branch-level totals are
 * `branch, total_balance`), so the first non-numeric column is the category the reader wants.
 */
export function pickDimension(columns: ServedColumn[]): string | null {
  return columns.find((column) => !isNumericType(column.type))?.name ?? null;
}

/** Render a dimension cell as a category label; a null value gets a visible label, not "". */
function categoryLabel(cell: ServedCell): string {
  return cell === null ? NULL_CATEGORY_LABEL : String(cell);
}

/**
 * Summarize a page of served data for the mini dashboard.
 *
 * The bars are **sorted by magnitude**, which is the dashboard's own ordering: the pipeline does
 * not guarantee a row order (the generated transform groups without an `ORDER BY`), so there is
 * no report order to preserve and sorting is what makes a magnitude comparison readable.
 *
 * `chartable` is false when the measure has any negative value: a bar grown from a zero baseline
 * would then encode magnitude but hide sign, and a reader comparing lengths would draw a false
 * conclusion. The tiles and the table still show those values — only the chart is withheld.
 */
export function summarizeServedData(data: ServedData): ServedSummary {
  const measure = pickMeasure(data.columns);
  const dimension = pickDimension(data.columns);
  const complete = data.rows.length === data.rowCount;

  if (!measure) {
    return {
      dimension,
      measure: null,
      bars: [],
      groupCount: 0,
      measureTotal: null,
      aggregated: false,
      complete,
      chartable: false,
    };
  }

  // Only genuine numbers are summed: a null cell contributes nothing, and a BIGINT past JSON's
  // safe range arrives as a string, which must not be coerced into a rounded number here.
  const measureOf = (row: Record<string, ServedCell>): number => {
    const cell = row[measure];
    return typeof cell === "number" ? cell : 0;
  };
  const measureTotal = data.rows.reduce((sum, row) => sum + measureOf(row), 0);

  if (!dimension) {
    return {
      dimension: null,
      measure,
      bars: [],
      groupCount: 0,
      measureTotal,
      aggregated: false,
      complete,
      chartable: false,
    };
  }

  const totals = new Map<string, { value: number; rows: number }>();
  for (const row of data.rows) {
    const label = categoryLabel(row[dimension] ?? null);
    const group = totals.get(label) ?? { value: 0, rows: 0 };
    group.value += measureOf(row);
    group.rows += 1;
    totals.set(label, group);
  }

  const ranked = [...totals.entries()]
    .map(([label, group]) => ({ label, value: group.value }))
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
  const bars = ranked.slice(0, MAX_DASHBOARD_BARS);

  return {
    dimension,
    measure,
    bars,
    groupCount: ranked.length,
    measureTotal,
    aggregated: [...totals.values()].some((group) => group.rows > 1),
    complete,
    chartable: bars.length > 0 && bars.every((bar) => bar.value >= 0) && bars[0]!.value > 0,
  };
}

/**
 * Format a measure for display: thousands-separated, and never more than two decimals so a
 * floating-point sum renders as money rather than as `1750.7500000000002`.
 */
export function formatMeasure(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
