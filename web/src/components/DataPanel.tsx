import { useCallback, useEffect, useState } from "react";
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
 * over REST rather than the live stream. Until anything at all has run, the panel stays collapsed
 * and outside the accessibility tree; its zero-width grid column lets it slide in without a jump.
 */
export function DataPanel({
  state,
  sessionId = null,
  onVisibilityChange,
}: {
  state: SessionLiveState;
  sessionId?: string | null;
  onVisibilityChange?: (visible: boolean) => void;
}) {
  const profile = latestProfile(state.messages);
  const result = latestQueryResult(state.messages);
  const endpoints = latestEndpoints(state.messages);
  const [lineageState, setLineageState] = useState<{
    sessionId: string | null;
    hasEvents: boolean;
  }>({ sessionId: null, hasEvents: false });
  const hasLineage = lineageState.sessionId === sessionId && lineageState.hasEvents;
  const hasLiveContent = profile !== null || result !== null || endpoints.length > 0;
  const hasContent = hasLiveContent || hasLineage;
  // Refetch the persisted lineage when a turn settles (a just-landed write/approval then shows).
  const refreshKey = `${state.messages.length}:${state.isWorking}`;
  const handleLineagePresence = useCallback(
    (hasEvents: boolean) => setLineageState({ sessionId, hasEvents }),
    [sessionId],
  );

  useEffect(() => {
    onVisibilityChange?.(hasContent);
  }, [hasContent, onVisibilityChange]);

  return (
    <aside
      aria-label="Data panel"
      aria-hidden={!hasContent}
      data-open={hasContent ? "true" : "false"}
      className="data-panel flex min-w-0 flex-col overflow-hidden border-l border-slate-200/80 bg-white/95 shadow-[-18px_0_50px_-38px_rgba(15,23,42,0.5)] backdrop-blur"
    >
      <header className="flex items-center gap-3 border-b border-slate-200/80 px-5 py-4">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-violet-100 text-violet-700" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" stroke="currentColor" strokeWidth="1.8">
            <ellipse cx="12" cy="5" rx="7" ry="3" />
            <path d="M5 5v7c0 1.7 3.1 3 7 3s7-1.3 7-3V5M5 12v7c0 1.7 3.1 3 7 3s7-1.3 7-3v-7" />
          </svg>
        </span>
        <div>
          <h2 className="text-sm font-semibold tracking-tight text-slate-900">Workspace data</h2>
          <p className="text-xs text-slate-500">Live outputs from this session</p>
        </div>
      </header>
      {hasContent ? (
        <div className="flex-1 space-y-7 overflow-auto p-5">
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
            <section
              aria-label="Audit trail"
              aria-hidden={!hasLineage}
              className={hasLineage ? undefined : "hidden"}
            >
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                Audit trail
              </h3>
              <LineageView
                sessionId={sessionId}
                refreshKey={refreshKey}
                onPresenceChange={handleLineagePresence}
              />
            </section>
          )}
        </div>
      ) : sessionId !== null ? (
        <LineageView
          sessionId={sessionId}
          refreshKey={refreshKey}
          onPresenceChange={handleLineagePresence}
        />
      ) : null}
    </aside>
  );
}
