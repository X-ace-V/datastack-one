import type { SourceProfile } from "../lib/api";

/**
 * Renders a {@link SourceProfile} (FR2 / T2.4): the summary counts plus a per-column table of
 * type, null %, distinct count, and the candidate-primary-key and date-column flags. Pure
 * presentation — it takes the profile the profile stage produced and shows it for review.
 */
export function SchemaTable({ profile }: { profile: SourceProfile }) {
  return (
    <section aria-label="Source profile" className="space-y-3">
      <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-slate-700">
        <div>
          <dt className="inline font-medium text-slate-500">Rows: </dt>
          <dd className="inline tabular-nums">{profile.rowCount.toLocaleString()}</dd>
        </div>
        <div>
          <dt className="inline font-medium text-slate-500">Columns: </dt>
          <dd className="inline tabular-nums">{profile.columnCount}</dd>
        </div>
        <div>
          <dt className="inline font-medium text-slate-500">Candidate keys: </dt>
          <dd className="inline">
            {profile.candidateKeys.length > 0 ? profile.candidateKeys.join(", ") : "none"}
          </dd>
        </div>
        <div>
          <dt className="inline font-medium text-slate-500">Date columns: </dt>
          <dd className="inline">
            {profile.dateColumns.length > 0 ? profile.dateColumns.join(", ") : "none"}
          </dd>
        </div>
      </dl>

      <div className="overflow-x-auto rounded-md border border-slate-200">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
            <tr>
              <th scope="col" className="px-3 py-2">Column</th>
              <th scope="col" className="px-3 py-2">Type</th>
              <th scope="col" className="px-3 py-2 text-right">Null %</th>
              <th scope="col" className="px-3 py-2 text-right">Distinct</th>
              <th scope="col" className="px-3 py-2">Flags</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {profile.columns.map((column) => (
              <tr key={column.name}>
                <td className="px-3 py-2 font-medium text-slate-900">{column.name}</td>
                <td className="px-3 py-2 font-mono text-xs text-slate-600">{column.type}</td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                  {column.nullPercent}%
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                  {column.distinctCount.toLocaleString()}
                </td>
                <td className="px-3 py-2">
                  <span className="flex flex-wrap gap-1">
                    {column.isCandidateKey && (
                      <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-medium text-indigo-700">
                        key
                      </span>
                    )}
                    {column.isDateColumn && (
                      <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700">
                        date
                      </span>
                    )}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
