import type { PublishedEndpoint } from "../lib/endpoints";

/**
 * The "endpoints" section of the data panel (TASKS V4.2, PRD FR11/FR12) — the REST endpoints the
 * agent has published this session, pulled from the live chat stream's `publish_serving` tool events
 * ({@link file://../lib/endpoints.ts}'s `latestEndpoints`). Each row names the served table, how many
 * rows it serves, and links straight to the generated JSON endpoint and its CSV download — the URLs
 * the backend derived (`/api/serve/:name` + `.csv`), so the UI never rebuilds a route prefix it would
 * have to keep in sync. Links open in a new tab so leaving the chat to inspect a payload does not
 * discard the session. Rendered only when there is at least one endpoint, so it carries no empty
 * state of its own (the panel's placeholder covers "nothing yet").
 */
export function EndpointsList({ endpoints }: { endpoints: PublishedEndpoint[] }) {
  return (
    <section aria-label="Published endpoints">
      <ul className="space-y-2">
        {endpoints.map((endpoint) => (
          <li key={endpoint.name} className="rounded-xl border border-slate-200 bg-white p-3.5 shadow-sm">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate font-mono text-sm font-medium text-slate-800">
                {endpoint.name}
              </span>
              <span className="shrink-0 text-xs text-slate-500">
                {endpoint.rowCount.toLocaleString()} rows
              </span>
            </div>
            <div className="mt-2 flex gap-3 text-xs">
              <a
                className="rounded-md bg-violet-50 px-2 py-1 font-semibold text-violet-700 transition hover:bg-violet-100"
                href={endpoint.endpoint}
                target="_blank"
                rel="noreferrer"
              >
                REST
              </a>
              <a
                className="rounded-md bg-slate-100 px-2 py-1 font-semibold text-slate-700 transition hover:bg-slate-200"
                href={endpoint.csvEndpoint}
                target="_blank"
                rel="noreferrer"
              >
                CSV
              </a>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
