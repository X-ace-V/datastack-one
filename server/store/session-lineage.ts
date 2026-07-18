import { randomUUID } from "node:crypto";
import type { WarehouseStore } from "./duckdb.js";
import {
  LineageEventSchema,
  parseLineageDetail,
  type LineageEvent,
  type LineageKind,
  type LineageStatus,
} from "../core/session-lineage.js";

/**
 * Persistence for the v2 conversational agent's per-session lineage/audit log (PRD FR12, V4.4),
 * in the DuckDB `platform.lineage` table. An I/O module (it wraps a {@link WarehouseStore}), so it
 * lives under `server/store`; the shapes are the pure {@link file://../core/session-lineage.ts}.
 * Every write binds input through positional parameters — no field is concatenated into SQL — and
 * `detail` is stored as a JSON string so a structured payload (args + result, reviewed metadata, DQ
 * outcomes) round-trips. Timestamps are cast to VARCHAR on read so they arrive as plain strings.
 *
 * Ordering: `seq` is assigned as `max(seq)+1` within a session (0 for the first event), mirroring
 * the transcript's message `seq` ({@link file://./sessions.ts}), so the log is monotonic and
 * gap-free regardless of wall-clock ties. Reads order by `seq`.
 */

/** The column list every lineage read selects; `created_at` cast to VARCHAR to read as a string. */
const LINEAGE_COLUMNS =
  "id, session_id, run_id, seq, kind, tool, status, detail, " +
  "CAST(created_at AS VARCHAR) AS created_at";

/** Map a raw `platform.lineage` row (snake_case, bigint seq, JSON detail string) to a validated event. */
function rowToLineageEvent(row: Record<string, unknown>): LineageEvent {
  return LineageEventSchema.parse({
    id: row.id,
    sessionId: row.session_id,
    runId: row.run_id ?? null,
    // DuckDB returns BIGINT columns as bigint; the contract is a plain number.
    seq: Number(row.seq),
    kind: row.kind,
    tool: row.tool ?? null,
    status: row.status ?? null,
    detail: parseLineageDetail((row.detail as string | null) ?? null),
    createdAt: row.created_at,
  });
}

/** Fields needed to append one lineage event; `id`/`seq`/`createdAt` are assigned by the store. */
export interface RecordLineageInput {
  /** The chat session the event belongs to. */
  sessionId: string;
  /** The kind of auditable event. */
  kind: LineageKind;
  /** The build grouping id, or `null`/undefined for an ad-hoc event (the MVP agent path). */
  runId?: string | null;
  /** The tool the event concerns (`tool_call`/`approval`), or `null`/undefined. */
  tool?: string | null;
  /** The terminal status, or `null`/undefined when a kind carries none. */
  status?: LineageStatus | null;
  /** The kind-specific payload, serialized to JSON for the row; `null`/undefined for none. */
  detail?: Record<string, unknown> | null;
}

/**
 * Append one event to a session's lineage log and return it as persisted. The next `seq` is
 * derived as `max(seq)+1` within the session; the row is read back after insert so the caller sees
 * exactly what stored (including the store-stamped `created_at`).
 */
export async function recordLineageEvent(
  store: WarehouseStore,
  input: RecordLineageInput,
): Promise<LineageEvent> {
  const seqRows = await store.all(
    `SELECT COALESCE(MAX(seq), -1) + 1 AS next_seq
       FROM platform.lineage WHERE session_id = $1`,
    [input.sessionId],
  );
  const seq = Number(seqRows[0]?.next_seq ?? 0);
  const id = randomUUID();

  await store.run(
    `INSERT INTO platform.lineage (id, session_id, run_id, seq, kind, tool, status, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      id,
      input.sessionId,
      input.runId ?? null,
      seq,
      input.kind,
      input.tool ?? null,
      input.status ?? null,
      input.detail == null ? null : JSON.stringify(input.detail),
    ],
  );

  const rows = await store.all(
    `SELECT ${LINEAGE_COLUMNS} FROM platform.lineage WHERE id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row) {
    throw new Error(`lineage event ${id} was not found immediately after insert`);
  }
  return rowToLineageEvent(row);
}

/** List a session's lineage events in `seq` order — the audit trail the run/lineage view renders. */
export async function listSessionLineage(
  store: WarehouseStore,
  sessionId: string,
): Promise<LineageEvent[]> {
  const rows = await store.all(
    `SELECT ${LINEAGE_COLUMNS} FROM platform.lineage
      WHERE session_id = $1 ORDER BY seq`,
    [sessionId],
  );
  return rows.map(rowToLineageEvent);
}
