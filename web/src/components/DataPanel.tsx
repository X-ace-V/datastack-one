import { EndpointsList } from "./EndpointsList";
import { LineageView } from "./LineageView";
import { ResultTable } from "./ResultTable";
import { SchemaTable } from "./SchemaTable";
import { latestQueryResult } from "../lib/query";
import { latestProfile } from "../lib/profile";
import { latestEndpoints } from "../lib/endpoints";
import type { SessionLiveState } from "../store/sessionStore";

/**
 * The right-hand data panel of the shell (ARCHITECTURE §4) — the "computer" view beside the chat.
 * It renders the agent's read-tool output *from the live chat stream*: `profile_source` attaches a
 * schema profile and `run_query` a result table to their tool-call `metadata`, which rides the SSE
 * tool event into the store; {@link latestProfile}/{@link latestQueryResult} pull the latest of each
 * back out (PRD FR6/FR7/FR12). The schema shows above the most recent query result, and any published
 * REST endpoints below them.
 *
 * Below those, when a session is active, the persisted **audit trail** (V4.4, FR12) — write tool
 * calls, approvals, DQ results — is rendered by {@link LineageView}, which reads it from the store
 * over REST rather than the live stream. Until anything at all has run, the panel shows its
 * placeholder.
 */
export function DataPanel({
  state,
  sessionId = null,
}: {
  state: SessionLiveState;
  sessionId?: string | null;
}) {
  const profile = latestProfile(state.messages);
  const result = latestQueryResult(state.messages);
  const endpoints = latestEndpoints(state.messages);
  // The audit trail shows whenever a session is active (empty until a write/check runs), so an
  // active session always has panel content even before its first query.
  const hasContent =
    profile !== null || result !== null || endpoints.length > 0 || sessionId !== null;
  // Refetch the persisted lineage when a turn settles (a just-landed write/approval then shows).
  const refreshKey = `${state.messages.length}:${state.isWorking}`;

  return (
    <aside
      aria-label="Data panel"
      className="flex flex-col overflow-hidden border-l border-slate-200 bg-white"
    >
      <header className="border-b border-slate-200 px-4 py-3">
        <h2 className="text-sm font-semibold tracking-tight">Data</h2>
      </header>
      {hasContent ? (
        <div className="flex-1 space-y-6 overflow-auto p-4">
          {profile && (
            <section>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                Schema
              </h3>
              <SchemaTable profile={profile} />
            </section>
          )}
          {result && (
            <section>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                Query result
              </h3>
              <ResultTable result={result} />
            </section>
          )}
          {endpoints.length > 0 && (
            <section>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                Endpoints
              </h3>
              <EndpointsList endpoints={endpoints} />
            </section>
          )}
          {sessionId !== null && (
            <section aria-label="Audit trail">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                Audit trail
              </h3>
              <LineageView sessionId={sessionId} refreshKey={refreshKey} />
            </section>
          )}
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center px-4 text-center text-sm text-slate-400">
          Schema, query results, and endpoints appear here
        </div>
      )}
    </aside>
  );
}
