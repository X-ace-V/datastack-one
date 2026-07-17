import { z } from "zod";

/**
 * Pure session contract (PRD FR1, v2 conversational agent). A session is one chat with
 * the data-engineering agent: it maps 1:1 to an embedded OpenCode session (its `id` IS the
 * OpenCode session id) and carries a human `title`, an optional per-session `model`, and a
 * persisted message history so it reopens with its transcript. It is persisted in the
 * DuckDB `platform.sessions` / `platform.messages` tables by
 * {@link file://../store/sessions.ts} and orchestrated by
 * {@link file://../opencode/sessions.ts}.
 *
 * This module stays pure — no fs/net/process — so the request/response shapes can be
 * validated at the route boundary (V1.2) and reused by the store, the manager, and the UI.
 */

/** Roles a persisted message may carry. Tool/approval detail lives in `platform.lineage`. */
export const MESSAGE_ROLES = ["user", "assistant"] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];

/** Fallback title when a session is created without one, so `title` is never empty. */
export const DEFAULT_SESSION_TITLE = "New session";

/**
 * Request body for creating a session. Both fields are optional: an untitled create falls
 * back to {@link DEFAULT_SESSION_TITLE}, and an unset `model` means the platform default
 * applies at prompt time (never duplicate the default into a stored row). Strings are
 * trimmed so " " never passes as a non-empty title/model.
 */
export const CreateSessionRequestSchema = z.object({
  /** Human label for the session; defaults to {@link DEFAULT_SESSION_TITLE} when omitted. */
  title: z.string().trim().min(1).optional(),
  /** Per-session model ref (e.g. `opencode/big-pickle`); `null`/omitted → platform default. */
  model: z.string().trim().min(1).optional(),
});
export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;

/** Request body for renaming a session (`PATCH /api/sessions/:id`). A title is required. */
export const RenameSessionRequestSchema = z.object({
  /** The new human label; trimmed and non-empty. */
  title: z.string().trim().min(1),
});
export type RenameSessionRequest = z.infer<typeof RenameSessionRequestSchema>;

/**
 * A persisted session as returned by the API. `model` is nullable (unset → platform
 * default). `createdAt`/`updatedAt` are DB timestamps rendered as strings; `updatedAt`
 * bumps on rename and on each appended message so the sidebar can order by recent activity.
 */
export const SessionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  model: z.string().nullable(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type Session = z.infer<typeof SessionSchema>;

/**
 * One persisted transcript message. `seq` orders messages monotonically within a session
 * (wall-clock `createdAt` can tie at sub-ms resolution), so a reopened session replays in
 * `seq` order rather than insertion order.
 */
export const MessageSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  seq: z.number().int().nonnegative(),
  role: z.enum(MESSAGE_ROLES),
  content: z.string(),
  createdAt: z.string().min(1),
});
export type Message = z.infer<typeof MessageSchema>;

/**
 * A session together with its ordered message history — the shape `GET /api/sessions/:id`
 * (V1.2) returns so reopening a session restores its transcript in one call.
 */
export const SessionWithHistorySchema = SessionSchema.extend({
  messages: z.array(MessageSchema),
});
export type SessionWithHistory = z.infer<typeof SessionWithHistorySchema>;
