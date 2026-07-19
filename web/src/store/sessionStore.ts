// Per-session live-state store for the conversational agent (TASKS V2.1, PRD FR2/FR3/FR10,
// ARCHITECTURE §4). The SSE hook (V2.2) routes every normalized chat event here; the store
// folds the stream into an ordered transcript per session and mirrors only the ACTIVE
// session to React state — background sessions accumulate silently in a Map and are pushed
// to React when the user switches to them. Mirrors Crux's `useSessionStore`, sized down to
// this app's normalized-event contract (no subagents, MCP apps, or file diffs).
//
// The reducer (`reduce`) is pure and exhaustively unit-tested; the hook is a thin ref-backed
// wrapper around it so the fold logic can be verified without React.

import { useCallback, useRef, useState } from "react";
import {
  createSession as createSessionApi,
  deleteSession as deleteSessionApi,
  listSessions as listSessionsApi,
  listSessionStatuses,
  renameSession as renameSessionApi,
  uploadSessionSource,
  getSessionFolder as getSessionFolderApi,
  refreshSessionFolder as refreshSessionFolderApi,
  type AttachmentRef,
  type Session,
  type SessionFolder,
  type SessionRuntimeStatus,
  type SessionSourceView,
  type WorkspaceFile,
} from "../lib/api";

// --- Web mirror of the backend normalized-event contract (server/core/events.ts) ---
// Web mirrors the wire shapes as plain types rather than importing server code (NodeNext,
// zod), exactly as `lib/api.ts` mirrors the REST schemas. Kept in sync with the SSE stream.

/** OpenCode's native tool-call statuses, as they stream over `GET /api/events`. */
export type ToolStatus = "pending" | "running" | "completed" | "error";

/** A captured, still-pending permission request (mirror of the backend `ApprovalRequest`). */
export interface ApprovalRequest {
  /** Permission id — the `:requestID` answered via `POST /api/approvals/:requestID`. */
  requestID: string;
  /** The session the reply is posted against. */
  sessionID: string;
  /** The gated surface/tool (e.g. `run_transform`), shown on the pill. */
  type: string;
  /** The permission metadata — carries the exact SQL/DDL a human reviews before approving. */
  metadata: Record<string, unknown>;
  /** The tool call this gates, when it originates from a tool. */
  callID?: string;
  /** The patterns the permission applies to (e.g. the command run). */
  patterns?: string[];
}

export interface TextEvent {
  kind: "text";
  sessionID: string;
  messageID: string;
  partID: string;
  text: string;
}
export interface ReasoningEvent {
  kind: "reasoning";
  sessionID: string;
  messageID: string;
  partID: string;
  text: string;
}
export interface ToolEvent {
  kind: "tool";
  sessionID: string;
  messageID: string;
  partID: string;
  callID: string;
  tool: string;
  status: ToolStatus;
  input?: Record<string, unknown>;
  output?: string;
  error?: string;
  title?: string;
  /** Structured tool payload for the data panel (e.g. `run_query`'s `{ result }`). */
  metadata?: Record<string, unknown>;
}
export interface IdleEvent {
  kind: "idle";
  sessionID: string;
}
export interface ErrorEvent {
  kind: "error";
  sessionID: string;
  message: string;
}
export interface ApprovalEvent extends ApprovalRequest {
  kind: "approval";
}
export interface ApprovalResolvedEvent {
  kind: "approval_resolved";
  sessionID: string;
  requestID: string;
  status: "approved" | "rejected";
}
export interface SessionUpdatedEvent {
  kind: "session_updated";
  sessionID: string;
  title: string;
}
export interface SessionStatusEvent {
  kind: "session_status";
  sessionID: string;
  status: "idle" | "busy" | "retry";
  message?: string;
}

/** The discriminated union delivered over `GET /api/events` (FR3). */
export type NormalizedEvent =
  | TextEvent
  | ReasoningEvent
  | ToolEvent
  | IdleEvent
  | ErrorEvent
  | ApprovalEvent
  | ApprovalResolvedEvent
  | SessionUpdatedEvent
  | SessionStatusEvent;

// --- Rendered transcript model ---

/** The resolution of an inline approval pill (FR10). `pending` until a human answers. */
export type ApprovalStatus = "pending" | "approved" | "rejected";

/**
 * One rendered unit of an assistant turn, in reading order (ARCHITECTURE §4). The stream
 * interleaves streamed text, agent reasoning, tool cards, and inline approval pills; the
 * store keeps them as an ordered list so `InlineSteps` (V2.5) renders them exactly as they
 * arrived — an approval pill sits next to the tool call it gates.
 */
export type InlineBlock =
  | { kind: "text"; partID: string; text: string }
  | { kind: "reasoning"; partID: string; text: string }
  | {
      kind: "tool";
      callID: string;
      tool: string;
      status: ToolStatus;
      input?: Record<string, unknown>;
      output?: string;
      error?: string;
      title?: string;
      metadata?: Record<string, unknown>;
    }
  | {
      kind: "approval";
      requestID: string;
      /** The gated surface/tool, from the approval's `type`. */
      approvalType: string;
      metadata: Record<string, unknown>;
      callID?: string;
      patterns?: string[];
      status: ApprovalStatus;
    };

/** A user turn — plain text the user typed (or the runtime echoed back). */
export interface UserMessage {
  role: "user";
  id: string;
  content: string;
  attachments?: AttachmentRef[];
}

/** An assistant turn — one OpenCode message (`id` is its `messageID`) of ordered blocks. */
export interface AssistantMessage {
  role: "assistant";
  /** The OpenCode `messageID` — every streamed part of this turn shares it. */
  id: string;
  blocks: InlineBlock[];
}

export type ChatMessage = UserMessage | AssistantMessage;

/**
 * The live state of one chat session. `messages` is the ordered transcript (user turns and
 * assistant turns with their inline blocks); `pendingApprovals` are the unresolved gates the
 * composer must block on (FR10); `isWorking` is true while a turn is in flight (until `idle`
 * or `error`); `error` holds the last turn failure. The two `echo*` fields are internal
 * bookkeeping for suppressing the runtime's echo of the user's own prompt (see `reduce`).
 */
export interface SessionLiveState {
  messages: ChatMessage[];
  pendingApprovals: ApprovalRequest[];
  isWorking: boolean;
  error: string | null;
  /** Composer state is per session, so switching never moves a draft or file queue across chats. */
  draft: string;
  attachments: ComposerAttachment[];
  folder: SessionFolder | null;
  workspaceFiles: WorkspaceFile[];
  folderError: string | null;
  /**
   * User prompts sent this session whose runtime echo has not yet been bound to a messageID.
   * The runtime re-streams the user's prompt as a `text` event carrying no role, so the store
   * matches an incoming text part against these to classify (and drop) the echo.
   */
  pendingEchoes: string[];
  /** MessageIDs classified as the user's own prompt echo — their parts are suppressed. */
  echoMessageIds: string[];
}

/** A fresh, empty session state — no history, idle, no pending gates. */
export function createEmptySessionState(): SessionLiveState {
  return {
    messages: [],
    pendingApprovals: [],
    isWorking: false,
    error: null,
    draft: "",
    attachments: [],
    folder: null,
    workspaceFiles: [],
    folderError: null,
    pendingEchoes: [],
    echoMessageIds: [],
  };
}

// --- Pure reducer ---

/**
 * One persisted message as `GET /api/sessions/:id` returns it (V6.2) — the shape a reopen
 * hydrates from. `blocks` carries an assistant turn's rendered tool-block history; a user turn
 * carries only its `content`. Mirrors the backend `MessageSchema`; the persisted block kinds
 * are exactly the store's `InlineBlock` minus the transient `approval` pill.
 */
export interface PersistedMessage {
  role: "user" | "assistant";
  id: string;
  content: string;
  blocks?: Array<Exclude<InlineBlock, { kind: "approval" }>>;
  attachments?: AttachmentRef[];
}

export type ComposerAttachmentStatus = "uploading" | "ready" | "error";
export interface ComposerAttachment {
  id: string;
  file: File;
  name: string;
  size: number;
  status: ComposerAttachmentStatus;
  source?: SessionSourceView;
  error?: string;
}

/**
 * The actions the store folds over: a normalized SSE event, an imperative user turn, a reset, or
 * a reopen `hydrate` that seeds the transcript from persisted history (V6.2).
 */
export type StoreAction =
  | { type: "event"; event: NormalizedEvent }
  | { type: "user-message"; id: string; text: string; attachments?: AttachmentRef[] }
  | { type: "hydrate"; messages: PersistedMessage[] }
  | { type: "set-draft"; text: string }
  | { type: "add-attachments"; attachments: ComposerAttachment[] }
  | { type: "update-attachment"; id: string; patch: Partial<ComposerAttachment> }
  | { type: "remove-attachment"; id: string }
  | { type: "clear-ready-attachments" }
  | { type: "folder"; folder: SessionFolder | null; files: WorkspaceFile[]; error?: string | null }
  | { type: "reset" };

/**
 * Upsert an inline block into the assistant message for `messageID`, creating that message
 * (appended to the transcript) if it does not exist yet. A block matching `sameBlock` is
 * replaced in place (so streamed text/tool-status updates land where they started); otherwise
 * the block is appended, preserving first-seen reading order.
 */
function upsertBlock(
  messages: ChatMessage[],
  messageID: string,
  block: InlineBlock,
  sameBlock: (b: InlineBlock) => boolean,
): ChatMessage[] {
  const idx = messages.findIndex(
    (m): m is AssistantMessage => m.role === "assistant" && m.id === messageID,
  );
  if (idx < 0) {
    const created: AssistantMessage = { role: "assistant", id: messageID, blocks: [block] };
    return [...messages, created];
  }
  const target = messages[idx] as AssistantMessage;
  const blockIdx = target.blocks.findIndex(sameBlock);
  const blocks =
    blockIdx >= 0
      ? target.blocks.map((b, i) => (i === blockIdx ? block : b))
      : [...target.blocks, block];
  return messages.map((m, i) => (i === idx ? { ...target, blocks } : m));
}

/** Append an approval pill to the assistant turn that owns its `callID` (else the last one). */
function appendApproval(messages: ChatMessage[], event: ApprovalEvent): ChatMessage[] {
  const block: InlineBlock = {
    kind: "approval",
    requestID: event.requestID,
    approvalType: event.type,
    metadata: event.metadata,
    callID: event.callID,
    patterns: event.patterns,
    status: "pending",
  };
  // Prefer the assistant message holding the gated tool call; fall back to the latest one.
  let idx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== "assistant") continue;
    if (idx < 0) idx = i; // remember the latest assistant turn as the fallback
    if (event.callID && m.blocks.some((b) => b.kind === "tool" && b.callID === event.callID)) {
      idx = i;
      break;
    }
  }
  if (idx < 0) {
    // No assistant turn yet (approval before any streamed content) — start one to host it.
    return [...messages, { role: "assistant", id: `approval:${event.requestID}`, blocks: [block] }];
  }
  const target = messages[idx] as AssistantMessage;
  return messages.map((m, i) =>
    i === idx ? { ...target, blocks: [...target.blocks, block] } : m,
  );
}

/** Mark the approval pill for `requestID` resolved wherever it lives in the transcript. */
function resolveApproval(
  messages: ChatMessage[],
  requestID: string,
  status: ApprovalStatus,
): ChatMessage[] {
  return messages.map((m) => {
    if (m.role !== "assistant") return m;
    let changed = false;
    const blocks = m.blocks.map((b) => {
      if (b.kind === "approval" && b.requestID === requestID) {
        changed = true;
        return { ...b, status };
      }
      return b;
    });
    return changed ? { ...m, blocks } : m;
  });
}

/**
 * Fold one action into a session's live state, returning a new state (never mutating the
 * input) so the hook can trigger a React render by identity. Handles the seven normalized
 * event kinds plus the imperative user turn:
 *
 * - `text`/`reasoning` upsert a block on the assistant message for their `messageID`, keyed by
 *   `partID` (the runtime resends the full accumulated part text, so upsert replaces).
 * - `tool` upserts by `callID`, stable across its `pending → running → completed/error` updates.
 * - `approval` adds an inline pill (and a pending gate); `approval_resolved` clears it (FR10).
 * - `idle`/`error` end the turn; `idle` also clears any unmatched echo bookkeeping.
 * - a `user-message` appends the user's turn and arms echo suppression: the runtime re-streams
 *   the prompt as a role-less `text` event, so the first text part matching a pending prompt is
 *   bound to that `messageID` and every part of it is dropped (no phantom assistant bubble).
 */
export function reduce(state: SessionLiveState, action: StoreAction): SessionLiveState {
  if (action.type === "reset") return createEmptySessionState();

  if (action.type === "set-draft") return { ...state, draft: action.text };
  if (action.type === "add-attachments") {
    return { ...state, attachments: [...state.attachments, ...action.attachments] };
  }
  if (action.type === "update-attachment") {
    return {
      ...state,
      attachments: state.attachments.map((attachment) =>
        attachment.id === action.id ? { ...attachment, ...action.patch } : attachment,
      ),
    };
  }
  if (action.type === "remove-attachment") {
    return { ...state, attachments: state.attachments.filter((item) => item.id !== action.id) };
  }
  if (action.type === "clear-ready-attachments") {
    return { ...state, attachments: state.attachments.filter((item) => item.status !== "ready") };
  }
  if (action.type === "folder") {
    return {
      ...state,
      folder: action.folder,
      workspaceFiles: action.files,
      folderError: action.error ?? null,
    };
  }

  if (action.type === "hydrate") {
    // Reopen: rebuild the transcript from persisted history (V6.2). A user turn becomes a plain
    // bubble; an assistant turn is reconstructed from its stored blocks (its tool-block history),
    // falling back to a single text block from `content` for a row saved before blocks existed.
    const messages: ChatMessage[] = action.messages.map((m) => {
      if (m.role === "assistant") {
        const blocks: InlineBlock[] =
          m.blocks && m.blocks.length > 0
            ? m.blocks
            : [{ kind: "text", partID: `${m.id}:text`, text: m.content }];
        return { role: "assistant", id: m.id, blocks };
      }
      return { role: "user", id: m.id, content: m.content, attachments: m.attachments };
    });
    // A hydrate replaces the transcript with the persisted one and clears live/echo bookkeeping;
    // the caller only hydrates a session that has no live state, so nothing streamed is lost.
    return {
      ...state,
      messages,
      pendingApprovals: [],
      isWorking: false,
      error: null,
      pendingEchoes: [],
      echoMessageIds: [],
    };
  }

  if (action.type === "user-message") {
    return {
      ...state,
      isWorking: true,
      error: null,
      messages: [
        ...state.messages,
        {
          role: "user",
          id: action.id,
          content: action.text,
          ...(action.attachments && action.attachments.length > 0
            ? { attachments: action.attachments }
            : {}),
        },
      ],
      pendingEchoes: [...state.pendingEchoes, action.text],
    };
  }

  const event = action.event;
  switch (event.kind) {
    case "text": {
      // Suppress the runtime's echo of the user's own prompt (it streams with no role).
      if (state.echoMessageIds.includes(event.messageID)) return state;
      const alreadyAssistant = state.messages.some(
        (m) => m.role === "assistant" && m.id === event.messageID,
      );
      if (!alreadyAssistant && event.text.length > 0) {
        const echoIdx = state.pendingEchoes.findIndex((p) => p.startsWith(event.text));
        if (echoIdx >= 0) {
          // Bind this messageID to the pending prompt on first sight and drop it; further
          // parts of this messageID are dropped by the echoMessageIds guard above.
          return {
            ...state,
            echoMessageIds: [...state.echoMessageIds, event.messageID],
            pendingEchoes: state.pendingEchoes.filter((_, i) => i !== echoIdx),
          };
        }
      }
      const block: InlineBlock = { kind: "text", partID: event.partID, text: event.text };
      return {
        ...state,
        isWorking: true,
        messages: upsertBlock(
          state.messages,
          event.messageID,
          block,
          (b) => b.kind === "text" && b.partID === event.partID,
        ),
      };
    }
    case "reasoning": {
      if (state.echoMessageIds.includes(event.messageID)) return state;
      const block: InlineBlock = { kind: "reasoning", partID: event.partID, text: event.text };
      return {
        ...state,
        isWorking: true,
        messages: upsertBlock(
          state.messages,
          event.messageID,
          block,
          (b) => b.kind === "reasoning" && b.partID === event.partID,
        ),
      };
    }
    case "tool": {
      if (state.echoMessageIds.includes(event.messageID)) return state;
      const block: InlineBlock = {
        kind: "tool",
        callID: event.callID,
        tool: event.tool,
        status: event.status,
        input: event.input,
        output: event.output,
        error: event.error,
        title: event.title,
        metadata: event.metadata,
      };
      return {
        ...state,
        isWorking: true,
        messages: upsertBlock(
          state.messages,
          event.messageID,
          block,
          (b) => b.kind === "tool" && b.callID === event.callID,
        ),
      };
    }
    case "approval": {
      const { kind: _kind, ...request } = event;
      const already = state.pendingApprovals.some((a) => a.requestID === event.requestID);
      return {
        ...state,
        isWorking: true,
        messages: appendApproval(state.messages, event),
        pendingApprovals: already
          ? state.pendingApprovals
          : [...state.pendingApprovals, request],
      };
    }
    case "approval_resolved": {
      return {
        ...state,
        messages: resolveApproval(state.messages, event.requestID, event.status),
        pendingApprovals: state.pendingApprovals.filter(
          (a) => a.requestID !== event.requestID,
        ),
      };
    }
    case "idle": {
      // The turn finished — clear echo bookkeeping so a stale prompt can't shadow the next turn.
      return { ...state, isWorking: false, pendingEchoes: [], echoMessageIds: [] };
    }
    case "error": {
      return { ...state, isWorking: false, error: event.message };
    }
    // Session metadata/status is consumed by the central session index below. Status still
    // updates `isWorking` here so selecting an inactive busy session renders the right composer.
    case "session_status": {
      return {
        ...state,
        isWorking: event.status === "busy" || event.status === "retry",
        error: event.status === "retry" ? event.message ?? state.error : state.error,
      };
    }
    case "session_updated":
      return state;
    default: {
      // Exhaustiveness: every NormalizedEvent kind is handled above.
      const _never: never = event;
      void _never;
      return state;
    }
  }
}

// --- The hook: a per-session Map with active-session React sync ---

/**
 * The store surface a chat view consumes. `activeState` is the live state of the session
 * named by the most recent {@link Store.setActiveSession} — the only session mirrored to
 * React state, so background sessions accumulate in the Map without re-rendering. `handleEvent`
 * routes a normalized SSE event to its session by `event.sessionID`.
 */
export interface Store {
  /** The active session's live state (empty when no session is active). */
  activeState: SessionLiveState;
  /** The active session id, or null when none is selected. */
  activeSessionId: string | null;
  /** Central session index rendered by the sidebar; updated by REST mutations and SSE events. */
  sessions: SessionSummary[];
  sessionsLoading: boolean;
  sessionsError: string | null;
  /** Load the durable session list and OpenCode's current background status snapshot. */
  loadSessions: () => Promise<void>;
  /** Create, rename, and delete through the central index so every pane sees one source of truth. */
  createSession: () => Promise<Session>;
  renameSession: (sessionId: string, title: string) => Promise<Session>;
  deleteSession: (sessionId: string) => Promise<void>;
  /** Select the active session; its stored state is mirrored to `activeState` immediately. */
  setActiveSession: (sessionId: string | null) => void;
  /** Read a session's live state from the Map without making it active (null if unseen). */
  getState: (sessionId: string) => SessionLiveState | undefined;
  /** Route a normalized SSE event to its session (by `event.sessionID`) and fold it in. */
  handleEvent: (event: NormalizedEvent) => void;
  /** Append the user's turn to a session and arm echo suppression; returns the message id. */
  appendUserMessage: (sessionId: string, text: string, attachments?: AttachmentRef[]) => string;
  setDraft: (sessionId: string, text: string) => void;
  uploadFiles: (sessionId: string, files: File[]) => void;
  retryAttachment: (sessionId: string, attachmentId: string) => void;
  removeAttachment: (sessionId: string, attachmentId: string) => void;
  clearReadyAttachments: (sessionId: string) => void;
  loadFolder: (sessionId: string) => Promise<void>;
  /** Create and activate a new OpenCode chat whose immutable working directory is `path`. */
  openFolderSession: (path: string) => Promise<Session>;
  refreshFolder: (sessionId: string) => Promise<void>;
  /**
   * Seed a session's transcript from persisted history on reopen (V6.2). A no-op if the session
   * already has live state (streamed messages or a turn in flight), so a late-arriving fetch can
   * never clobber a conversation the user has already started.
   */
  hydrateSession: (sessionId: string, messages: PersistedMessage[]) => void;
  /** Drop a session's live state entirely (on delete). */
  removeSession: (sessionId: string) => void;
  /** Reset a session's live state to empty (keeps it in the Map). */
  reset: (sessionId: string) => void;
}

/** User-facing session lifecycle shown for active and inactive rows. */
export type SessionUiStatus = "idle" | "working" | "retry" | "waiting_approval" | "error";

/** Durable session metadata plus transient OpenCode/background state. */
export interface SessionSummary extends Session {
  status: SessionUiStatus;
  statusMessage?: string;
}

function uiStatus(status: SessionRuntimeStatus | undefined): SessionUiStatus {
  if (status?.type === "busy") return "working";
  if (status?.type === "retry") return "retry";
  return "idle";
}

/** Generate a client-side id for a user turn (browser crypto; falls back for old runtimes). */
function newMessageId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `msg-${Math.random().toString(36).slice(2)}`;
}

function newAttachmentId(): string {
  return `attachment-${newMessageId()}`;
}

/**
 * The per-session live-state store (ARCHITECTURE §4). Holds a `Map<sessionId, state>` in a
 * ref and mirrors only the active session to React state via `useState`, so a background
 * session streaming events updates the Map without re-rendering the view. Dispatch goes
 * through the pure {@link reduce}; only the active session's mutations call `setState`.
 */
export function useSessionStore(): Store {
  const mapRef = useRef<Map<string, SessionLiveState>>(new Map());
  const activeIdRef = useRef<string | null>(null);
  const [activeState, setActiveState] = useState<SessionLiveState>(createEmptySessionState);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const sessionMetaRef = useRef<
    Map<string, { title?: string; status?: SessionUiStatus; statusMessage?: string }>
  >(new Map());

  const ensure = useCallback((sessionId: string): SessionLiveState => {
    let s = mapRef.current.get(sessionId);
    if (!s) {
      s = createEmptySessionState();
      mapRef.current.set(sessionId, s);
    }
    return s;
  }, []);

  /** Fold an action into a session, persist it, and mirror to React if it is active. */
  const dispatch = useCallback((sessionId: string, action: StoreAction): SessionLiveState => {
    const next = reduce(ensure(sessionId), action);
    mapRef.current.set(sessionId, next);
    if (sessionId === activeIdRef.current) setActiveState(next);
    return next;
  }, [ensure]);

  const setActiveSession = useCallback((sessionId: string | null) => {
    activeIdRef.current = sessionId;
    setActiveSessionId(sessionId);
    setActiveState(sessionId ? ensure(sessionId) : createEmptySessionState());
  }, [ensure]);

  const getState = useCallback((sessionId: string) => mapRef.current.get(sessionId), []);

  const handleEvent = useCallback((event: NormalizedEvent) => {
    const next = dispatch(event.sessionID, { type: "event", event });
    const cached = sessionMetaRef.current.get(event.sessionID) ?? {};
    if (event.kind === "session_updated") {
      sessionMetaRef.current.set(event.sessionID, { ...cached, title: event.title });
    } else if (event.kind === "session_status") {
      sessionMetaRef.current.set(event.sessionID, {
        ...cached,
        status:
          event.status === "busy" ? "working" : event.status === "retry" ? "retry" : "idle",
        statusMessage: event.message,
      });
    } else if (event.kind === "approval") {
      sessionMetaRef.current.set(event.sessionID, { ...cached, status: "waiting_approval" });
    } else if (event.kind === "idle") {
      sessionMetaRef.current.set(event.sessionID, { ...cached, status: "idle" });
    } else if (event.kind === "error") {
      sessionMetaRef.current.set(event.sessionID, {
        ...cached,
        status: "error",
        statusMessage: event.message,
      });
    } else if (event.kind === "approval_resolved") {
      sessionMetaRef.current.set(event.sessionID, {
        ...cached,
        status:
          next.pendingApprovals.length > 0
            ? "waiting_approval"
            : next.isWorking
              ? "working"
              : "idle",
      });
    } else {
      sessionMetaRef.current.set(event.sessionID, { ...cached, status: "working" });
    }
    setSessions((current) =>
      current.map((session) => {
        if (session.id !== event.sessionID) return session;
        if (event.kind === "session_updated") {
          return { ...session, title: event.title };
        }
        if (event.kind === "session_status") {
          return {
            ...session,
            status:
              event.status === "busy"
                ? "working"
                : event.status === "retry"
                  ? "retry"
                  : "idle",
            statusMessage: event.message,
          };
        }
        if (event.kind === "approval") {
          return { ...session, status: "waiting_approval" };
        }
        if (event.kind === "approval_resolved") {
          return {
            ...session,
            status:
              next.pendingApprovals.length > 0
                ? "waiting_approval"
                : next.isWorking
                  ? "working"
                  : "idle",
          };
        }
        if (event.kind === "idle") return { ...session, status: "idle" };
        if (event.kind === "error") {
          return { ...session, status: "error", statusMessage: event.message };
        }
        return { ...session, status: "working" };
      }),
    );
  }, [dispatch]);

  const loadSessions = useCallback(async () => {
    setSessionsLoading(true);
    setSessionsError(null);
    try {
      const [listed, statuses] = await Promise.all([
        listSessionsApi(),
        listSessionStatuses().catch(() => ({} as Record<string, SessionRuntimeStatus>)),
      ]);
      setSessions(
        listed.map((session) => {
          const cached = sessionMetaRef.current.get(session.id);
          return {
            ...session,
            ...(cached?.title ? { title: cached.title } : {}),
            status: cached?.status ?? uiStatus(statuses[session.id]),
            ...(cached?.statusMessage ? { statusMessage: cached.statusMessage } : {}),
          };
        }),
      );
    } catch (error) {
      setSessionsError(error instanceof Error ? error.message : String(error));
    } finally {
      setSessionsLoading(false);
    }
  }, []);

  const createSession = useCallback(async () => {
    const session = await createSessionApi();
    setSessions((current) => [{ ...session, status: "idle" }, ...current]);
    return session;
  }, []);

  const renameSession = useCallback(async (sessionId: string, title: string) => {
    const updated = await renameSessionApi(sessionId, title);
    setSessions((current) =>
      current.map((session) =>
        session.id === sessionId ? { ...session, ...updated } : session,
      ),
    );
    return updated;
  }, []);

  const deleteSession = useCallback(async (sessionId: string) => {
    await deleteSessionApi(sessionId);
    setSessions((current) => current.filter((session) => session.id !== sessionId));
    mapRef.current.delete(sessionId);
    if (sessionId === activeIdRef.current) {
      activeIdRef.current = null;
      setActiveSessionId(null);
      setActiveState(createEmptySessionState());
    }
  }, []);

  const appendUserMessage = useCallback((
    sessionId: string,
    text: string,
    attachments: AttachmentRef[] = [],
  ) => {
    const id = newMessageId();
    dispatch(sessionId, { type: "user-message", id, text, attachments });
    setSessions((current) =>
      current.map((session) =>
        session.id === sessionId ? { ...session, status: "working" } : session,
      ),
    );
    return id;
  }, [dispatch]);

  const setDraft = useCallback((sessionId: string, text: string) => {
    dispatch(sessionId, { type: "set-draft", text });
  }, [dispatch]);

  const performUpload = useCallback((sessionId: string, attachment: ComposerAttachment) => {
    dispatch(sessionId, {
      type: "update-attachment",
      id: attachment.id,
      patch: { status: "uploading", error: undefined },
    });
    void uploadSessionSource(sessionId, attachment.file)
      .then((source) => {
        dispatch(sessionId, {
          type: "update-attachment",
          id: attachment.id,
          patch: { status: "ready", source, error: undefined },
        });
      })
      .catch((error: unknown) => {
        dispatch(sessionId, {
          type: "update-attachment",
          id: attachment.id,
          patch: {
            status: "error",
            error: error instanceof Error ? error.message : String(error),
          },
        });
      });
  }, [dispatch]);

  const uploadFiles = useCallback((sessionId: string, files: File[]) => {
    const attachments = files.map<ComposerAttachment>((file) => ({
      id: newAttachmentId(),
      file,
      name: file.name,
      size: file.size,
      status: "uploading",
    }));
    if (attachments.length === 0) return;
    dispatch(sessionId, { type: "add-attachments", attachments });
    for (const attachment of attachments) performUpload(sessionId, attachment);
  }, [dispatch, performUpload]);

  const retryAttachment = useCallback((sessionId: string, attachmentId: string) => {
    const attachment = mapRef.current
      .get(sessionId)
      ?.attachments.find((item) => item.id === attachmentId);
    if (attachment) performUpload(sessionId, attachment);
  }, [performUpload]);

  const removeAttachment = useCallback((sessionId: string, attachmentId: string) => {
    dispatch(sessionId, { type: "remove-attachment", id: attachmentId });
  }, [dispatch]);

  const clearReadyAttachments = useCallback((sessionId: string) => {
    dispatch(sessionId, { type: "clear-ready-attachments" });
  }, [dispatch]);

  const loadFolder = useCallback(async (sessionId: string) => {
    try {
      const result = await getSessionFolderApi(sessionId);
      dispatch(sessionId, { type: "folder", folder: result.folder, files: result.files });
    } catch (error) {
      dispatch(sessionId, {
        type: "folder",
        folder: null,
        files: [],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, [dispatch]);

  const openFolderSession = useCallback(async (path: string) => {
    // OpenCode fixes a session's cwd at creation time. Starting another folder therefore starts
    // another independent chat (the previous chat keeps running and remains in the sidebar).
    const session = await createSessionApi({ folderPath: path });
    const result = await getSessionFolderApi(session.id);
    dispatch(session.id, { type: "folder", folder: result.folder, files: result.files });
    setSessions((current) => [{ ...session, status: "idle" }, ...current]);
    setActiveSession(session.id);
    return session;
  }, [dispatch, setActiveSession]);

  const refreshFolder = useCallback(async (sessionId: string) => {
    const result = await refreshSessionFolderApi(sessionId);
    dispatch(sessionId, { type: "folder", folder: result.folder, files: result.files });
  }, [dispatch]);

  const hydrateSession = useCallback(
    (sessionId: string, messages: PersistedMessage[]) => {
      // Guard against clobbering a live session: only hydrate one with no streamed messages and
      // no turn in flight, so a slow reopen fetch that lands after the user starts typing is dropped.
      const existing = mapRef.current.get(sessionId);
      if (existing && (existing.messages.length > 0 || existing.isWorking)) return;
      dispatch(sessionId, { type: "hydrate", messages });
    },
    [dispatch],
  );

  const removeSession = useCallback((sessionId: string) => {
    mapRef.current.delete(sessionId);
    if (sessionId === activeIdRef.current) {
      activeIdRef.current = null;
      setActiveSessionId(null);
      setActiveState(createEmptySessionState());
    }
  }, []);

  const reset = useCallback((sessionId: string) => {
    dispatch(sessionId, { type: "reset" });
  }, [dispatch]);

  return {
    activeState,
    activeSessionId,
    sessions,
    sessionsLoading,
    sessionsError,
    loadSessions,
    createSession,
    renameSession,
    deleteSession,
    setActiveSession,
    getState,
    handleEvent,
    appendUserMessage,
    setDraft,
    uploadFiles,
    retryAttachment,
    removeAttachment,
    clearReadyAttachments,
    loadFolder,
    openFolderSession,
    refreshFolder,
    hydrateSession,
    removeSession,
    reset,
  };
}
