// Web mirror of the backend `run_query` result contract (server/core/query.ts) plus the selectors
// the data panel uses to pull the latest query result out of the live chat stream (TASKS V3.3,
// PRD FR7). The panel renders query results *from tool events*: `run_query` attaches its structured
// result to the tool call's `metadata` (server/tools/plugin.ts), which rides the SSE tool event
// into the session store; here we read it back out. Kept as plain types (no zod) exactly like
// lib/api.ts mirrors the REST schemas.

import type { ChatMessage } from "../store/sessionStore";

/** The tool name whose metadata carries a query result. */
export const RUN_QUERY_TOOL = "run_query";

/** One JSON-safe cell of a query result (mirror of the backend `ServedCell`). */
export type QueryCell = string | number | boolean | null;

/** One column of a query result: its name and DuckDB-reported type. */
export interface QueryColumn {
  name: string;
  type: string;
}

/** The result of a `run_query` call (mirror of the backend `QueryResult`). */
export interface QueryResult {
  columns: QueryColumn[];
  rows: Record<string, QueryCell>[];
  rowCount: number;
  truncated: boolean;
}

/** Whether a value is a JSON-safe query cell. */
function isCell(value: unknown): value is QueryCell {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

/**
 * Read a {@link QueryResult} out of a tool call's `metadata`, or `null` if it is absent or the
 * wrong shape. Defensive because the metadata arrives from the network as `Record<string, unknown>`:
 * a malformed payload must not crash the panel, it should simply render nothing.
 */
export function readQueryResult(metadata: Record<string, unknown> | undefined): QueryResult | null {
  const result = (metadata as { result?: unknown } | undefined)?.result;
  if (!result || typeof result !== "object") return null;
  const candidate = result as {
    columns?: unknown;
    rows?: unknown;
    rowCount?: unknown;
    truncated?: unknown;
  };
  if (!Array.isArray(candidate.columns) || !Array.isArray(candidate.rows)) return null;

  const columns: QueryColumn[] = [];
  for (const col of candidate.columns) {
    if (
      !col ||
      typeof col !== "object" ||
      typeof (col as { name?: unknown }).name !== "string" ||
      typeof (col as { type?: unknown }).type !== "string"
    ) {
      return null;
    }
    columns.push({ name: (col as QueryColumn).name, type: (col as QueryColumn).type });
  }

  const rows: Record<string, QueryCell>[] = [];
  for (const row of candidate.rows) {
    if (!row || typeof row !== "object") return null;
    const cells: Record<string, QueryCell> = {};
    for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
      if (!isCell(value)) return null;
      cells[key] = value;
    }
    rows.push(cells);
  }

  return {
    columns,
    rows,
    rowCount: typeof candidate.rowCount === "number" ? candidate.rowCount : rows.length,
    truncated: candidate.truncated === true,
  };
}

/**
 * The most recent completed `run_query` result across a session's transcript, or `null` if the
 * session has run no query yet. The data panel shows this — the latest question answered — so a
 * new query replaces the previous table. Scans newest-first and returns the first valid result.
 */
export function latestQueryResult(messages: ChatMessage[]): QueryResult | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || message.role !== "assistant") continue;
    for (let j = message.blocks.length - 1; j >= 0; j--) {
      const block = message.blocks[j];
      if (
        block &&
        block.kind === "tool" &&
        block.tool === RUN_QUERY_TOOL &&
        block.status === "completed"
      ) {
        const result = readQueryResult(block.metadata);
        if (result) return result;
      }
    }
  }
  return null;
}
