import { isNumericType } from "../lib/dashboard";
import type { ServedCell, ServedData } from "../lib/api";

/**
 * Renders a page of a served table (T5.4 / FR10) — the "table preview" of the published report,
 * and the table view that keeps every value in the mini dashboard's chart reachable as text.
 *
 * Pure presentation over whatever the generated transform produced: the columns come from the
 * published export, so this knows no column names. Rows are shown in the export's order and the
 * component adds no ordering of its own — the pipeline does not guarantee one (the generated
 * transform groups without an `ORDER BY`), so any order shown here is the file's, not a contract.
 */

/** Render one cell: a null is shown as a visible dash, not an empty cell that reads as blank. */
function cellText(cell: ServedCell): string {
  if (cell === null) return "—";
  if (typeof cell === "boolean") return cell ? "true" : "false";
  return String(cell);
}

export function DataTable({ data }: { data: ServedData }) {
  const numeric = new Set(
    data.columns.filter((column) => isNumericType(column.type)).map((column) => column.name),
  );
  const showing = data.rows.length;
  const partial = showing < data.rowCount;

  return (
    <section aria-label="Served data" className="space-y-2">
      <div className="overflow-x-auto rounded-md border border-slate-200">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
            <tr>
              {data.columns.map((column) => (
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
            {data.rows.map((row, index) => (
              // The export has no key column of its own, so position in the page is the identity.
              <tr key={index}>
                {data.columns.map((column) => (
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
            {data.rows.length === 0 && (
              <tr>
                <td
                  colSpan={Math.max(data.columns.length, 1)}
                  className="px-3 py-6 text-center text-sm text-slate-500"
                >
                  This report published no rows.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-slate-500">
        {partial
          ? `Showing ${showing.toLocaleString()} of ${data.rowCount.toLocaleString()} rows — download the CSV for the full report.`
          : `${data.rowCount.toLocaleString()} ${data.rowCount === 1 ? "row" : "rows"}.`}
      </p>
    </section>
  );
}
