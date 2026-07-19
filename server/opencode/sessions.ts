import type { OpencodeClient } from "@opencode-ai/sdk";
import type { WarehouseStore } from "../store/duckdb.js";
import {
  ChatRequestSchema,
  CreateSessionRequestSchema,
  DEFAULT_SESSION_TITLE,
  SessionAgentStatusSchema,
  SessionAttachmentError,
  parseModelRef,
  type ChatRequest,
  type CreateSessionRequest,
  type Message,
  type MessageRole,
  type Session,
  type SessionAgentStatusInfo,
  type SessionWithHistory,
} from "../core/sessions.js";
import {
  appendMessage,
  deleteSession,
  getSession,
  insertSession,
  listMessages,
  listSessions,
  renameSession,
  updateSessionModel,
} from "../store/sessions.js";
import { getSessionSource } from "../store/session-sources.js";
import { getSessionFolder, listSessionFolders } from "../store/session-folders.js";

/**
 * SessionManager (PRD FR1, TASKS V1.1) — the one place the platform maps a chat session to
 * an embedded OpenCode session and persists it. It orchestrates two things behind one
 * interface: the OpenCode runtime (`client.session.create/update/delete`, which owns the
 * live agent session) and the DuckDB `platform` store (which owns the durable title, model,
 * and message history so a session reopens). Routes (V1.2), the chat turn (V1.3), and the
 * event bridge take the returned {@link Session} / history. See ARCHITECTURE §3.1.
 *
 * Both dependencies are injected, so a unit test drives it with a mocked client + a real
 * in-memory store (TASKS V1.1: "unit test against a mocked client").
 */

/**
 * Minimal client surface the manager needs: just the `session` group's create/update/delete
 * calls. Narrowing to this slice keeps the manager mockable without spawning the `opencode`
 * binary. The SDK returns a `{ data, error }` envelope per call (never throws by default),
 * so each method here asserts `error` is unset before trusting `data`.
 */
export type SessionManagerClient = Pick<OpencodeClient, "session">;

/** Raised when the OpenCode runtime returns an error envelope for a session operation. */
export class SessionRuntimeError extends Error {
  constructor(operation: string, detail: unknown) {
    super(`OpenCode session ${operation} failed: ${JSON.stringify(detail)}`);
    this.name = "SessionRuntimeError";
  }
}

/**
 * Create/get/list/rename/delete chat sessions and record their message history, keeping the
 * OpenCode runtime and the DuckDB store in step. The runtime is the source of truth for the
 * live agent; the store is the source of truth for the durable metadata the UI reads.
 */
export class SessionManager {
  constructor(
    private readonly client: SessionManagerClient,
    private readonly store: WarehouseStore,
  ) {}

  /**
   * OpenCode's v1 APIs are directory-scoped. A session keeps the cwd it was created with, but
   * every later request still needs to address that directory's runtime instance. Legacy folder
   * attachments are deliberately ignored: only a folder recorded as the immutable workspace
   * root may steer an OpenCode call.
   */
  private async runtimeQuery(id: string): Promise<{ query: { directory: string } } | object> {
    const folder = await getSessionFolder(this.store, id);
    return folder?.workspaceRoot ? { query: { directory: folder.path } } : {};
  }

  /**
   * Create a chat session: open an OpenCode session, then persist it under its OpenCode id.
   * An omitted title is also omitted from OpenCode's request. That is load-bearing: OpenCode
   * only runs its native first-prompt title generator while the session still has its own
   * default title. `model` is platform metadata, stored as the per-session default for turns.
   *
   * If the runtime fails, nothing is persisted — the store never holds a session with no
   * live OpenCode counterpart.
   */
  async create(input: CreateSessionRequest = {}): Promise<Session> {
    const parsed = CreateSessionRequestSchema.parse(input);
    const res = await this.client.session.create({
      body: parsed.title === undefined ? {} : { title: parsed.title },
      ...(parsed.folderPath ? { query: { directory: parsed.folderPath } } : {}),
    });
    if (res.error || !res.data) {
      throw new SessionRuntimeError("create", res.error ?? "no session returned");
    }

    return insertSession(this.store, {
      id: res.data.id,
      // OpenCode is canonical for session titles. Its create response carries either the
      // explicit title or its native default placeholder; the fallback only protects an older
      // or malformed runtime response from violating the store's NOT NULL contract.
      title:
        typeof res.data.title === "string" && res.data.title.trim().length > 0
          ? res.data.title
          : parsed.title ?? DEFAULT_SESSION_TITLE,
      model: parsed.model ?? null,
    });
  }

  /**
   * Mirror a title emitted by OpenCode's native title generator into the durable session index.
   * This never calls `session.update` back into the runtime (which would loop the event); it only
   * updates the platform cache used by the sidebar and restart recovery.
   */
  async syncRuntimeTitle(id: string, title: string): Promise<Session | null> {
    const clean = title.trim();
    if (!clean) return getSession(this.store, id);
    const existing = await getSession(this.store, id);
    if (!existing || existing.title === clean) return existing;
    return renameSession(this.store, id, clean);
  }

  /** Return OpenCode's live status map so a browser reload can recover background activity. */
  async status(): Promise<Record<string, SessionAgentStatusInfo>> {
    const statuses: Record<string, SessionAgentStatusInfo> = {};
    const folders = await listSessionFolders(this.store);
    const directories = [
      undefined,
      ...new Set(
        folders.filter((folder) => folder.workspaceRoot).map((folder) => folder.path),
      ),
    ];
    const responses = await Promise.all(
      directories.map((directory) =>
        this.client.session.status(
          directory ? { query: { directory } } : {},
        ),
      ),
    );
    for (const res of responses) {
      if (res.error || !res.data) {
        throw new SessionRuntimeError("status", res.error ?? "no status map returned");
      }
      for (const [id, status] of Object.entries(res.data)) {
        statuses[id] = SessionAgentStatusSchema.parse(status);
      }
    }
    return statuses;
  }

  /**
   * Return a session with its ordered message history, or `null` if unknown — the shape a
   * reopen needs to restore the transcript in one call.
   */
  async get(id: string): Promise<SessionWithHistory | null> {
    const session = await getSession(this.store, id);
    if (!session) {
      return null;
    }
    const messages = await listMessages(this.store, id);
    return { ...session, messages };
  }

  /** List all sessions, most recently active first (for the sidebar). */
  async list(): Promise<Session[]> {
    return listSessions(this.store);
  }

  /**
   * Rename a session in both the runtime and the store. Returns the updated session, or
   * `null` if the id is unknown (checked against the store first, so an unknown id never
   * hits the runtime). The store's `updated_at` bump floats the session up the sidebar.
   */
  async rename(id: string, title: string): Promise<Session | null> {
    const existing = await getSession(this.store, id);
    if (!existing) {
      return null;
    }

    const res = await this.client.session.update({
      path: { id },
      body: { title },
      ...(await this.runtimeQuery(id)),
    });
    if (res.error) {
      throw new SessionRuntimeError("update", res.error);
    }

    return renameSession(this.store, id, title);
  }

  /**
   * Set a session's per-session model (V6.1, FR11) — what the ModelPicker chose. Returns the
   * updated session, or `null` if the id is unknown (checked against the store first). A `null`
   * clears the override back to the platform default.
   *
   * The model is platform metadata (OpenCode picks the model per prompt, so `create`/`rename`
   * never send it to the runtime), so this touches only the store — no runtime round-trip. A
   * non-null ref is validated into `provider/model` before persisting, so a malformed ref is a
   * clean {@link SessionModelError} (route → 400) that leaves the stored model untouched.
   */
  async setModel(id: string, model: string | null): Promise<Session | null> {
    const existing = await getSession(this.store, id);
    if (!existing) {
      return null;
    }
    // Validate the shape before persisting; parseModelRef throws SessionModelError on a bad ref.
    if (model !== null) {
      parseModelRef(model);
    }
    return updateSessionModel(this.store, id, model);
  }

  /**
   * Delete a session from both the runtime and the store (including its message history).
   * Returns `true` if a session existed, `false` otherwise — so a route can 404 cleanly. The
   * unknown id is caught against the store first, so a no-op delete never hits the runtime.
   */
  async delete(id: string): Promise<boolean> {
    const existing = await getSession(this.store, id);
    if (!existing) {
      return false;
    }

    const res = await this.client.session.delete({
      path: { id },
      ...(await this.runtimeQuery(id)),
    });
    if (res.error) {
      throw new SessionRuntimeError("delete", res.error);
    }

    return deleteSession(this.store, id);
  }

  /**
   * Append a message to a session's persisted transcript (FR1 history). The chat turn (V1.3)
   * records the user's prompt here; the assistant's reply (its text + tool-block history) is
   * persisted separately by the transcript persister (V6.2,
   * {@link file://./transcript.ts}) when the turn goes idle, so reopening the session replays
   * the whole conversation. `seq`/`updated_at` are handled by the store.
   */
  async appendMessage(
    sessionId: string,
    role: MessageRole,
    content: string,
  ): Promise<Message> {
    return appendMessage(this.store, { sessionId, role, content });
  }

  /**
   * Send a natural-language turn to a session (PRD FR2). Persists the user's prompt to the
   * transcript, then fires `session.prompt` at the OpenCode runtime and returns immediately —
   * the assistant's reasoning, tool calls, and reply stream back over SSE (the event bridge,
   * V1.4/V1.5) rather than being awaited here, which is what lets the route answer `202` fast.
   *
   * Returns the persisted user {@link Message} (so the UI can render it at once with its
   * assigned `seq`), or `null` if the session id is unknown (checked against the store first,
   * so an unknown id never reaches the runtime). The model for the turn is resolved as
   * turn-override → session default → platform default; a malformed override/stored ref throws
   * {@link file://../core/sessions.ts}'s `SessionModelError` before anything is persisted.
   */
  async chat(sessionId: string, input: ChatRequest): Promise<Message | null> {
    const parsed = ChatRequestSchema.parse(input);

    const existing = await getSession(this.store, sessionId);
    if (!existing) {
      return null;
    }

    // Resolve + validate the model BEFORE persisting, so a bad ref is a clean failure that
    // leaves no dangling user turn with no agent reply. Omitted → the runtime's default.
    const ref = parsed.model ?? existing.model ?? undefined;
    const model = ref ? parseModelRef(ref) : undefined;

    // Validate every safe source name against THIS session before persisting or prompting. A
    // guessed name from another chat cannot cross the boundary even if it exists globally.
    const attachments = parsed.attachments ?? [];
    const text = parsed.text ?? "";
    for (const attachment of attachments) {
      const source = await getSessionSource(this.store, sessionId, attachment.name);
      if (!source || source.kind !== attachment.kind) {
        throw new SessionAttachmentError(attachment.name);
      }
    }

    const message = await appendMessage(this.store, {
      sessionId,
      role: "user",
      content: text,
      attachments,
    });

    const attachmentContext = attachments.length
      ? [
          "",
          "Files attached to this turn (session-owned source names):",
          ...attachments.map((file) => `- ${file.name} (${file.kind})`),
          "Use list_sources/profile_source/run_query or read_workspace_file as appropriate.",
        ].join("\n")
      : "";
    const promptText = `${text || "Inspect the attached files and explain what you find."}${attachmentContext}`;

    // Fire-and-forget: the turn runs in the background and its output streams over SSE. We do
    // not await it (that is what keeps the route fast) and swallow a transport rejection here —
    // a runtime failure surfaces to the client as a `session.error` event on the stream, not
    // as this call's result. The SDK returns a `{ data, error }` envelope rather than throwing,
    // so this catch only guards an unexpected transport-level reject from becoming unhandled.
    void this.client.session
      .prompt({
        path: { id: sessionId },
        ...(await this.runtimeQuery(sessionId)),
        body: {
          parts: [{ type: "text", text: promptText }],
          ...(model ? { model } : {}),
        },
      })
      .catch(() => {});

    return message;
  }

  /**
   * Cancel the in-flight turn on a session (PRD FR2) via `session.abort`. Returns `true` if the
   * session exists (checked against the store first, so an unknown id never hits the runtime),
   * `false` otherwise — so a route can 404 cleanly. A runtime error envelope becomes a
   * {@link SessionRuntimeError} (route → 502). Aborting an idle session is a harmless no-op.
   */
  async cancel(sessionId: string): Promise<boolean> {
    const existing = await getSession(this.store, sessionId);
    if (!existing) {
      return false;
    }

    const res = await this.client.session.abort({
      path: { id: sessionId },
      ...(await this.runtimeQuery(sessionId)),
    });
    if (res.error) {
      throw new SessionRuntimeError("abort", res.error);
    }

    return true;
  }
}
