import { isNumericType } from "../lib/dashboard";
import type { QueryCell, QueryResult } from "../lib/query";

/**
 * Renders a `run_query` result in the data panel (TASKS V3.3, PRD FR7/FR12) — the table the agent
 * gets back when it answers a question in SQL. Pure presentation over whatever the model's query
 * returned, so it knows no column names: numeric columns are right-aligned by their DuckDB type,
 * nulls show as a visible dash, and a truncated result says so rather than implying the whole
 * table came back. Mirrors {@link file://./DataTable.tsx} (the served-report table), sized to the
 * live query-result shape.
 */

/** Render one cell: a null is a visible dash, not a blank that reads as empty. */
function cellText(cell: QueryCell): string {
  if (cell === null) return "—";
  if (typeof cell === "boolean") return cell ? "true" : "false";
  return String(cell);
}

export function ResultTable({ result }: { result: QueryResult }) {
  const numeric = new Set(
    result.columns.filter((column) => isNumericType(column.type)).map((column) => column.name),
  );

  return (
    <section aria-label="Query result" className="space-y-2">
      <div className="overflow-x-auto rounded-xl border border-slate-200 shadow-sm">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
            <tr>
              {result.columns.map((column) => (
                <th
                  key={column.name}
                  scope="col"
                  className={`px-3 py-2 ${numeric.has(column.name) ? "text-right" : ""}`}
                >
                  {column.name}
                  <span className="ml-1 font-mono text-[10px] font-normal normal-case text-slate-400">
                    {column.type}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {result.rows.map((row, index) => (
              // A query result has no key column of its own, so row position is the identity.
              <tr key={index} className="transition-colors hover:bg-slate-50/80">
                {result.columns.map((column) => (
                  <td
                    key={column.name}
                    className={`px-3 py-2 text-slate-700 ${
                      numeric.has(column.name) ? "text-right tabular-nums" : ""
                    } ${row[column.name] === null ? "text-slate-400" : ""}`}
                  >
                    {cellText(row[column.name] ?? null)}
                  </td>
                ))}
              </tr>
            ))}
            {result.rows.length === 0 && (
              <tr>
                <td
                  colSpan={Math.max(result.columns.length, 1)}
                  className="px-3 py-6 text-center text-sm text-slate-500"
                >
                  The query returned no rows.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-slate-500">
        {result.truncated
          ? `Showing the first ${result.rowCount.toLocaleString()} rows — refine the query for fewer.`
          : `${result.rowCount.toLocaleString()} ${result.rowCount === 1 ? "row" : "rows"}.`}
      </p>
    </section>
  );
}
