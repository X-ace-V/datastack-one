import { randomUUID } from "node:crypto";
import type { WarehouseStore } from "./duckdb.js";
import {
  MessageSchema,
  SessionSchema,
  type Message,
  type MessageRole,
  type Session,
} from "../core/sessions.js";

/**
 * Persistence for chat sessions and their message history (PRD FR1, v2) in the DuckDB
 * `platform.sessions` / `platform.messages` tables. An I/O module by design — it wraps a
 * {@link WarehouseStore} — so it lives under `server/store`, not `server/core`. Every write
 * binds user input through parameters ($1, $2, …); no field is ever concatenated into SQL.
 * See ARCHITECTURE §3.1, §3.4.
 */

/**
 * The column list every session read selects. Both timestamps are cast to VARCHAR so they
 * arrive as plain strings (`getRowObjects` otherwise returns `DuckDBTimestampValue` objects)
 * that {@link SessionSchema} can validate directly.
 */
const SESSION_COLUMNS =
  "id, title, model, CAST(created_at AS VARCHAR) AS created_at, " +
  "CAST(updated_at AS VARCHAR) AS updated_at";

/** The column list every message read selects; `created_at` cast to VARCHAR as above. */
const MESSAGE_COLUMNS =
  "id, session_id, seq, role, content, CAST(created_at AS VARCHAR) AS created_at";

/** Map a raw `platform.sessions` row (snake_case, nullable model) to a {@link Session}. */
function rowToSession(row: Record<string, unknown>): Session {
  return SessionSchema.parse({
    id: row.id,
    title: row.title,
    model: row.model ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

/** Map a raw `platform.messages` row (snake_case, bigint seq) to a {@link Message}. */
function rowToMessage(row: Record<string, unknown>): Message {
  return MessageSchema.parse({
    id: row.id,
    sessionId: row.session_id,
    // DuckDB returns BIGINT columns as bigint; the contract is a plain number.
    seq: Number(row.seq),
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
  });
}

/** Fields needed to record a session. `id` is the OpenCode session id (caller-supplied). */
export interface InsertSessionInput {
  /** The OpenCode session id — this row's primary key, so a session reopens by it. */
  id: string;
  /** Human label for the session. */
  title: string;
  /** Per-session model ref, or `null`/undefined for the platform default. */
  model?: string | null;
}

/**
 * Insert a session and return it as persisted. The id is the OpenCode session id (not
 * server-generated here); `created_at`/`updated_at` come from the table, so the row is read
 * back after the insert rather than echoing the input — the caller sees exactly what stored.
 */
export async function insertSession(
  store: WarehouseStore,
  input: InsertSessionInput,
): Promise<Session> {
  await store.run(
    `INSERT INTO platform.sessions (id, title, model) VALUES ($1, $2, $3)`,
    [input.id, input.title, input.model ?? null],
  );

  const session = await getSession(store, input.id);
  if (!session) {
    throw new Error(`session ${input.id} was not found immediately after insert`);
  }
  return session;
}

/** Fetch a single session by id, or `null` if none exists. */
export async function getSession(
  store: WarehouseStore,
  id: string,
): Promise<Session | null> {
  const rows = await store.all(
    `SELECT ${SESSION_COLUMNS} FROM platform.sessions WHERE id = $1`,
    [id],
  );
  const row = rows[0];
  return row ? rowToSession(row) : null;
}

/**
 * List all sessions, most recently active first (`updated_at` bumps on rename and on each
 * appended message), with `id` breaking ties for a stable order — so the sidebar (V2.3)
 * shows the freshest conversation on top.
 */
export async function listSessions(store: WarehouseStore): Promise<Session[]> {
  const rows = await store.all(
    `SELECT ${SESSION_COLUMNS} FROM platform.sessions ORDER BY updated_at DESC, id`,
  );
  return rows.map(rowToSession);
}

/**
 * Rename a session and bump `updated_at`. Returns the updated row, or `null` if the id is
 * unknown (so a caller can 404 rather than fabricate a row). The title binds as a parameter.
 */
export async function renameSession(
  store: WarehouseStore,
  id: string,
  title: string,
): Promise<Session | null> {
  await store.run(
    `UPDATE platform.sessions SET title = $1, updated_at = now() WHERE id = $2`,
    [title, id],
  );
  return getSession(store, id);
}

/**
 * Set a session's per-session model and bump `updated_at` (V6.1, FR11). A `null` clears the
 * override back to the platform default. Returns the updated row, or `null` if the id is
 * unknown (so a caller can 404 rather than fabricate a row). The ref binds as a parameter.
 */
export async function updateSessionModel(
  store: WarehouseStore,
  id: string,
  model: string | null,
): Promise<Session | null> {
  await store.run(
    `UPDATE platform.sessions SET model = $1, updated_at = now() WHERE id = $2`,
    [model, id],
  );
  return getSession(store, id);
}

/**
 * Delete a session and its entire message history and lineage. Returns `true` if a session
 * existed (so a caller can 404 on a false), `false` otherwise. The child rows (transcript
 * messages, lineage/audit events) are removed first so nothing orphaned survives their session.
 */
export async function deleteSession(
  store: WarehouseStore,
  id: string,
): Promise<boolean> {
  const existing = await getSession(store, id);
  if (!existing) {
    return false;
  }
  await store.run(`DELETE FROM platform.messages WHERE session_id = $1`, [id]);
  await store.run(`DELETE FROM platform.lineage WHERE session_id = $1`, [id]);
  await store.run(`DELETE FROM platform.sessions WHERE id = $1`, [id]);
  return true;
}

/** Fields needed to append one transcript message; `seq` is assigned by the store. */
export interface AppendMessageInput {
  /** Owning session id. */
  sessionId: string;
  /** Who authored the message. */
  role: MessageRole;
  /** The message text. */
  content: string;
}

/**
 * Append a message to a session's transcript and bump the session's `updated_at`. The next
 * `seq` is derived as `max(seq)+1` within the session (0 for the first message), so ordering
 * is monotonic and gap-free regardless of wall-clock ties. Returns the persisted message.
 */
export async function appendMessage(
  store: WarehouseStore,
  input: AppendMessageInput,
): Promise<Message> {
  const seqRows = await store.all(
    `SELECT COALESCE(MAX(seq), -1) + 1 AS next_seq
       FROM platform.messages WHERE session_id = $1`,
    [input.sessionId],
  );
  const seq = Number(seqRows[0]?.next_seq ?? 0);
  const id = randomUUID();

  await store.run(
    `INSERT INTO platform.messages (id, session_id, seq, role, content)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, input.sessionId, seq, input.role, input.content],
  );
  // Appending a message counts as activity, so the session floats to the top of the sidebar.
  await store.run(
    `UPDATE platform.sessions SET updated_at = now() WHERE id = $1`,
    [input.sessionId],
  );

  const rows = await store.all(
    `SELECT ${MESSAGE_COLUMNS} FROM platform.messages WHERE id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row) {
    throw new Error(`message ${id} was not found immediately after insert`);
  }
  return rowToMessage(row);
}

/** List a session's messages in transcript (`seq`) order — the history a reopen replays. */
export async function listMessages(
  store: WarehouseStore,
  sessionId: string,
): Promise<Message[]> {
  const rows = await store.all(
    `SELECT ${MESSAGE_COLUMNS} FROM platform.messages
     WHERE session_id = $1 ORDER BY seq`,
    [sessionId],
  );
  return rows.map(rowToMessage);
}
