// Web mirror of the backend `profile_source` result contract (server/core/profile.ts) plus the
// selectors the data panel uses to pull the latest profile out of the live chat stream (TASKS V3.4,
// PRD FR6/FR12). The panel renders the schema *from tool events*: `profile_source` attaches its
// structured profile to the tool call's `metadata` (server/tools/plugin.ts), which rides the SSE
// tool event into the session store; here we read it back out — the exact seam `run_query` uses in
// lib/query.ts. Kept as plain types (no zod) like lib/api.ts mirrors the REST schemas; the reusable
// `SourceProfile`/`ColumnProfile` shapes already live in lib/api.

import type { ColumnProfile, SourceProfile } from "./api";
import type { ChatMessage } from "../store/sessionStore";

/** The tool name whose metadata carries a source profile. */
export const PROFILE_SOURCE_TOOL = "profile_source";

/** Whether a value is a finite number (JSON never yields NaN/Infinity, but be defensive). */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Whether every element of an array is a string. */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** Parse one column of a profile defensively, or `null` if any field is missing or the wrong type. */
function readColumn(value: unknown): ColumnProfile | null {
  if (!value || typeof value !== "object") return null;
  const col = value as Record<string, unknown>;
  if (
    typeof col.name !== "string" ||
    typeof col.type !== "string" ||
    !isFiniteNumber(col.nullCount) ||
    !isFiniteNumber(col.nullPercent) ||
    !isFiniteNumber(col.distinctCount) ||
    typeof col.isCandidateKey !== "boolean" ||
    typeof col.isDateColumn !== "boolean"
  ) {
    return null;
  }
  return {
    name: col.name,
    type: col.type,
    nullCount: col.nullCount,
    nullPercent: col.nullPercent,
    distinctCount: col.distinctCount,
    isCandidateKey: col.isCandidateKey,
    isDateColumn: col.isDateColumn,
  };
}

/**
 * Read a {@link SourceProfile} out of a tool call's `metadata`, or `null` if it is absent or the
 * wrong shape. Defensive because the metadata arrives from the network as `Record<string, unknown>`:
 * a malformed payload must not crash the panel, it should simply render nothing. Mirrors
 * {@link file://./query.ts}'s `readQueryResult`.
 */
export function readSourceProfile(
  metadata: Record<string, unknown> | undefined,
): SourceProfile | null {
  const profile = (metadata as { profile?: unknown } | undefined)?.profile;
  if (!profile || typeof profile !== "object") return null;
  const candidate = profile as Record<string, unknown>;
  if (
    !isFiniteNumber(candidate.rowCount) ||
    !isFiniteNumber(candidate.columnCount) ||
    !Array.isArray(candidate.columns) ||
    !isStringArray(candidate.candidateKeys) ||
    !isStringArray(candidate.dateColumns)
  ) {
    return null;
  }

  const columns: ColumnProfile[] = [];
  for (const raw of candidate.columns) {
    const column = readColumn(raw);
    if (!column) return null;
    columns.push(column);
  }

  return {
    rowCount: candidate.rowCount,
    columnCount: candidate.columnCount,
    columns,
    candidateKeys: candidate.candidateKeys,
    dateColumns: candidate.dateColumns,
  };
}

/**
 * The most recent completed `profile_source` result across a session's transcript, or `null` if the
 * session has profiled nothing yet. The data panel shows this — the latest source profiled — so a
 * new profile replaces the previous schema. Scans newest-first and returns the first valid profile.
 * Mirrors {@link file://./query.ts}'s `latestQueryResult`.
 */
export function latestProfile(messages: ChatMessage[]): SourceProfile | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || message.role !== "assistant") continue;
    for (let j = message.blocks.length - 1; j >= 0; j--) {
      const block = message.blocks[j];
      if (
        block &&
        block.kind === "tool" &&
        block.tool === PROFILE_SOURCE_TOOL &&
        block.status === "completed"
      ) {
        const profile = readSourceProfile(block.metadata);
        if (profile) return profile;
      }
    }
  }
  return null;
}
