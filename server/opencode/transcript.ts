import type { Event } from "@opencode-ai/sdk";
import type { MessageRole } from "../core/sessions.js";
import {
  assistantMessageText,
  blockKey,
  toPersistedBlock,
  type PersistedBlock,
} from "../core/transcript.js";
import type { WarehouseStore } from "../store/duckdb.js";
import { persistAssistantMessage } from "../store/sessions.js";
import { normalizeEvent } from "./bridge.js";

/**
 * Transcript persister (TASKS V6.2, PRD FR1). The chat turn (V1.3) persists the user's prompt,
 * but the assistant's reply — its streamed text, reasoning, and tool cards — only ever lived in
 * the browser's live-state store, so a restart or a fresh browser reopened a session with half
 * its history. This closes that gap: fed every raw event off the bridge's single pump (alongside
 * the approval gate), it accumulates each assistant turn's blocks and, when the turn goes idle,
 * writes them to `platform.messages` so `GET /api/sessions/:id` (V1.2) can reconstruct the whole
 * transcript on reopen. See ARCHITECTURE §3.1/§6.
 *
 * Roles are attributed authoritatively from the runtime's `message.updated` event
 * (`Message.role`), NOT guessed from the text stream (AGENTS: the runtime re-streams the user's
 * own prompt as a role-less text part, so only the assistant's own messages are persisted here —
 * the user's prompt is already stored by the chat turn). Blocks reuse the bridge's tested
 * {@link normalizeEvent} mapping, so what is persisted is exactly what streamed live.
 */

/** The persister surface: fed raw events, flushes an assistant turn's blocks at idle. */
export interface TranscriptPersister {
  /** Observe one raw runtime event (roles, block deltas, and the idle that triggers a flush). */
  ingest(event: Event): void;
  /**
   * Persist the accumulated assistant turns for a session and clear its buffer. Called on the
   * session's `idle` event; exposed so a test can flush deterministically without racing the
   * fire-and-forget write. Resolves once every assistant message for the session is written.
   */
  flush(sessionID: string): Promise<void>;
}

export interface TranscriptPersisterOptions {
  /** Called if a flush write rejects, so a persistence failure surfaces instead of vanishing. */
  onError?: (error: unknown) => void;
}

/** One assistant message being accumulated: its blocks keyed for in-place upsert, order kept. */
interface MessageAccumulator {
  /** First-seen position of this message within its session, so turns replay in arrival order. */
  order: number;
  /** Block keys in first-seen order (a `partID`/`callID` resend replaces, never reorders). */
  keyOrder: string[];
  /** The latest block for each key. */
  blocks: Map<string, PersistedBlock>;
}

/** Read a `message.updated` event's `{ id, role }`, or null if it is a different event. */
function readMessageRole(
  event: Event,
): { id: string; role: MessageRole } | null {
  const raw = event as unknown as { type: string; properties?: { info?: unknown } };
  if (raw.type !== "message.updated") return null;
  const info = raw.properties?.info as { id?: unknown; role?: unknown } | undefined;
  if (typeof info?.id !== "string" || info.id.length === 0) return null;
  // Only the two roles we persist against matter; anything else leaves the message unattributed
  // (and thus unpersisted), which is the safe default.
  if (info.role !== "user" && info.role !== "assistant") return null;
  return { id: info.id, role: info.role };
}

/** Read a `session.idle` event's session id, or null if it is a different event. */
function readIdleSessionId(event: Event): string | null {
  const raw = event as unknown as { type: string; properties?: { sessionID?: unknown } };
  if (raw.type !== "session.idle") return null;
  const id = raw.properties?.sessionID;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/**
 * Create the transcript persister over a warehouse store. Stateless across process restarts by
 * design: after a restart the runtime does not replay past events, so the accumulator starts
 * empty and only new turns are persisted (past turns were already written before the restart).
 */
export function createTranscriptPersister(
  store: WarehouseStore,
  options: TranscriptPersisterOptions = {},
): TranscriptPersister {
  /** messageID → role, learned from `message.updated`. */
  const roleOf = new Map<string, MessageRole>();
  /** sessionID → (messageID → accumulator). */
  const sessions = new Map<string, Map<string, MessageAccumulator>>();
  /** messageIDs already written, so a repeated idle never double-inserts. */
  const persisted = new Set<string>();
  let orderCounter = 0;

  function ingest(event: Event): void {
    const roleUpdate = readMessageRole(event);
    if (roleUpdate) {
      roleOf.set(roleUpdate.id, roleUpdate.role);
      return;
    }

    const idleSessionId = readIdleSessionId(event);
    if (idleSessionId) {
      void flush(idleSessionId).catch((error) => options.onError?.(error));
      return;
    }

    // Otherwise it may be a block-bearing part update — reuse the bridge's mapping.
    const normalized = normalizeEvent(event);
    if (!normalized) return;
    const key = blockKey(normalized);
    const block = toPersistedBlock(normalized);
    if (key === null || block === null) return;
    // `messageID` is present on exactly the block-bearing kinds (text/reasoning/tool).
    const messageID = (normalized as { messageID?: string }).messageID;
    const sessionID = normalized.sessionID;
    if (!messageID) return;

    let messages = sessions.get(sessionID);
    if (!messages) {
      messages = new Map();
      sessions.set(sessionID, messages);
    }
    let acc = messages.get(messageID);
    if (!acc) {
      acc = { order: orderCounter++, keyOrder: [], blocks: new Map() };
      messages.set(messageID, acc);
    }
    if (!acc.blocks.has(key)) acc.keyOrder.push(key);
    acc.blocks.set(key, block);
  }

  async function flush(sessionID: string): Promise<void> {
    const messages = sessions.get(sessionID);
    if (!messages) return;
    // Drop the buffer up front: the turn is over, so any straggling part is out of scope, and
    // this bounds memory across a long-lived process. `persisted` still guards a repeat idle.
    sessions.delete(sessionID);

    const ordered = [...messages.entries()].sort((a, b) => a[1].order - b[1].order);
    for (const [messageID, acc] of ordered) {
      if (persisted.has(messageID)) continue;
      if (roleOf.get(messageID) !== "assistant") continue;
      const blocks = acc.keyOrder
        .map((key) => acc.blocks.get(key))
        .filter((b): b is PersistedBlock => b !== undefined);
      if (blocks.length === 0) continue;
      // Mark persisted before the await so a second idle racing the write can't double-insert.
      persisted.add(messageID);
      await persistAssistantMessage(store, {
        sessionId: sessionID,
        messageID,
        content: assistantMessageText(blocks),
        blocks,
      });
    }
  }

  return { ingest, flush };
}
