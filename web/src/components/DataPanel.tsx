import { ResultTable } from "./ResultTable";
import { latestQueryResult } from "../lib/query";
import type { SessionLiveState } from "../store/sessionStore";

/**
 * The right-hand data panel of the shell (ARCHITECTURE §4) — the "computer" view beside the chat.
 * As of V3.3 it renders the latest `run_query` result: the agent answers an NL question with SQL,
 * the result rides the tool event into the store, and {@link latestQueryResult} pulls it back out
 * so the table shows here (PRD FR7/FR12). The schema view and published endpoints fill in beside it
 * in later tasks (V3.4+); until a query has run, the panel shows its placeholder.
 */
export function DataPanel({ state }: { state: SessionLiveState }) {
  const result = latestQueryResult(state.messages);

  return (
    <aside
      aria-label="Data panel"
      className="flex flex-col overflow-hidden border-l border-slate-200 bg-white"
    >
      <header className="border-b border-slate-200 px-4 py-3">
        <h2 className="text-sm font-semibold tracking-tight">Data</h2>
      </header>
      {result ? (
        <div className="flex-1 overflow-auto p-4">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Query result
          </h3>
          <ResultTable result={result} />
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center px-4 text-center text-sm text-slate-400">
          Schema, query results, and endpoints appear here
        </div>
      )}
    </aside>
  );
}
