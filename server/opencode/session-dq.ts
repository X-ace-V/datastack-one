import type { DqRunResult } from "../core/dq.js";

/**
 * The per-session data-quality gate (V4.3, PRD FR9). In the v2 conversational agent the pipeline
 * is agent-orchestrated, not a deterministic runner, so the "a failed DQ check blocks a later
 * publish" rule (FR9) cannot ride the v1 runner's throw-and-abort (see AGENTS.md #55). Instead the
 * `run_dq_check` tool records its outcome here, keyed by chat session, and the `publish_serving`
 * write route consults this gate BEFORE it opens its approval: if the session's most recent DQ run
 * failed, publish is refused and the agent surfaces that in the chat.
 *
 * "Most recent" is deliberate: if a run fails, the user fixes the data (or the checks) and re-runs
 * `run_dq_check`, a passing result replaces the failing one and publish is allowed again — the gate
 * reflects the latest known quality state, not a permanent strike. A session that has never run a
 * check is not blocked (nothing has failed); FR9 blocks on a *failed* check, not a missing one.
 *
 * State is in-memory and per-session, which suits the single-user localhost backend: the process
 * outlives every turn, so a check run in one turn still gates a publish attempted in a later turn.
 * Persisting the DQ results to lineage for the audit trail is a separate concern (V4.4).
 */

/** The per-session DQ gate surface consumed by the `run_dq_check` and `publish_serving` routes. */
export interface SessionDqGate {
  /** Record a session's most recent DQ run outcome, replacing any earlier one. */
  record(sessionID: string, result: DqRunResult): void;
  /** The session's most recent DQ run outcome, or `undefined` if none has run. */
  latest(sessionID: string): DqRunResult | undefined;
  /**
   * Whether a publish must be blocked for this session (FR9): true only when the most recent DQ
   * run for the session exists and did not pass. A session with no recorded run is never blocked.
   */
  isPublishBlocked(sessionID: string): boolean;
}

/** Create an in-memory per-session DQ gate. */
export function createSessionDqGate(): SessionDqGate {
  // sessionID → its most recent DQ run outcome. A later run overwrites an earlier one.
  const latestBySession = new Map<string, DqRunResult>();

  return {
    record(sessionID, result) {
      latestBySession.set(sessionID, result);
    },
    latest(sessionID) {
      return latestBySession.get(sessionID);
    },
    isPublishBlocked(sessionID) {
      const result = latestBySession.get(sessionID);
      return result !== undefined && result.passed === false;
    },
  };
}
