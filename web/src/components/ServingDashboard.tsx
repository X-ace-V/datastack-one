import { formatMeasure, summarizeServedData } from "../lib/dashboard";
import type { ServedSummary } from "../lib/dashboard";
import type { ServedData } from "../lib/api";

/**
 * The Serve step's mini dashboard (T5.4 / FR10: "a simple dashboard view of the final report").
 * A KPI row of stat tiles plus one magnitude-by-category chart of the report's first measure —
 * enough to read the published result at a glance, with the {@link DataTable} beside it carrying
 * every value as text.
 *
 * The chart is a single series, so it uses one hue and needs no legend (the heading names the
 * measure), and each bar is labeled at its tip rather than against an axis. All derivation lives
 * in {@link summarizeServedData}; this only renders it — including the cases where the honest
 * answer is to withhold the chart and say why.
 */

/** Why the chart is not drawn, in the reader's terms. Only called when `chartable` is false. */
function chartOmissionReason(summary: ServedSummary): string {
  if (!summary.measure) {
    return "This report has no numeric column, so there is nothing to chart — the table below shows every value.";
  }
  if (!summary.dimension) {
    return `This report has no categorical column to break ${summary.measure} down by — the table below shows every value.`;
  }
  if (summary.bars.length === 0) {
    return "This report published no rows to chart.";
  }
  if (summary.bars.some((bar) => bar.value < 0)) {
    return `${summary.measure} has negative values, so bars grown from a zero baseline would show their size but hide their sign — the table below shows every value.`;
  }
  return `Every ${summary.measure} in this report is zero, so there are no proportions to chart.`;
}

/** One headline number. The value uses proportional figures — these are not a column to align. */
function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-slate-200 px-3 py-2">
      <dt className="text-xs font-medium text-slate-500">{label}</dt>
      <dd className="mt-0.5 text-xl font-semibold text-slate-900">{value}</dd>
    </div>
  );
}

export function ServingDashboard({ data }: { data: ServedData }) {
  const summary = summarizeServedData(data);
  const max = summary.bars[0]?.value ?? 0;
  const truncated = summary.groupCount > summary.bars.length;

  return (
    <section aria-label="Report dashboard" className="space-y-4">
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Rows served" value={data.rowCount.toLocaleString()} />
        <StatTile label="Columns" value={String(data.columns.length)} />
        {summary.measure && summary.measureTotal !== null && (
          <StatTile
            label={summary.complete ? `Total ${summary.measure}` : `Total ${summary.measure} (page)`}
            value={formatMeasure(summary.measureTotal)}
          />
        )}
        <StatTile label="Published" value={data.publishedAt.slice(0, 16)} />
      </dl>

      {summary.chartable && summary.dimension && summary.measure ? (
        <figure className="space-y-2">
          <figcaption className="text-sm font-medium text-slate-700">
            {summary.aggregated ? "Total " : ""}
            {summary.measure} by {summary.dimension}
            {truncated && (
              <span className="ml-1 font-normal text-slate-500">
                — top {summary.bars.length} of {summary.groupCount}
              </span>
            )}
          </figcaption>
          <ul className="space-y-2">
            {summary.bars.map((bar) => (
              <li key={bar.label} className="flex items-center gap-3 text-sm">
                <span className="w-28 shrink-0 truncate text-slate-600" title={bar.label}>
                  {bar.label}
                </span>
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <span
                    className="h-3 rounded-r-[4px] bg-indigo-600"
                    // The bar is the only mark carrying the measure, so its length is the
                    // encoding: proportional to the largest category, from a zero baseline.
                    style={{ width: `${max > 0 ? (bar.value / max) * 100 : 0}%` }}
                    title={`${bar.label}: ${formatMeasure(bar.value)}`}
                  />
                  <span className="shrink-0 tabular-nums text-slate-700">
                    {formatMeasure(bar.value)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
          {!summary.complete && (
            <p className="text-xs text-slate-500">
              Summarizing the {data.rows.length.toLocaleString()} rows on this page, not all{" "}
              {data.rowCount.toLocaleString()}.
            </p>
          )}
        </figure>
      ) : (
        <p className="text-sm text-slate-600">{chartOmissionReason(summary)}</p>
      )}
    </section>
  );
}
