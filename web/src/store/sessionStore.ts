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

/** The discriminated union delivered over `GET /api/events` (FR3). */
export type NormalizedEvent =
  | TextEvent
  | ReasoningEvent
  | ToolEvent
  | IdleEvent
  | ErrorEvent
  | ApprovalEvent
  | ApprovalResolvedEvent;

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
}

/**
 * The actions the store folds over: a normalized SSE event, an imperative user turn, a reset, or
 * a reopen `hydrate` that seeds the transcript from persisted history (V6.2).
 */
export type StoreAction =
  | { type: "event"; event: NormalizedEvent }
  | { type: "user-message"; id: string; text: string }
  | { type: "hydrate"; messages: PersistedMessage[] }
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
      return { role: "user", id: m.id, content: m.content };
    });
    // A hydrate replaces the transcript with the persisted one and clears live/echo bookkeeping;
    // the caller only hydrates a session that has no live state, so nothing streamed is lost.
    return { ...createEmptySessionState(), messages };
  }

  if (action.type === "user-message") {
    return {
      ...state,
      isWorking: true,
      error: null,
      messages: [...state.messages, { role: "user", id: action.id, content: action.text }],
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
  /** Select the active session; its stored state is mirrored to `activeState` immediately. */
  setActiveSession: (sessionId: string | null) => void;
  /** Read a session's live state from the Map without making it active (null if unseen). */
  getState: (sessionId: string) => SessionLiveState | undefined;
  /** Route a normalized SSE event to its session (by `event.sessionID`) and fold it in. */
  handleEvent: (event: NormalizedEvent) => void;
  /** Append the user's turn to a session and arm echo suppression; returns the message id. */
  appendUserMessage: (sessionId: string, text: string) => string;
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

/** Generate a client-side id for a user turn (browser crypto; falls back for old runtimes). */
function newMessageId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `msg-${Math.random().toString(36).slice(2)}`;
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
    dispatch(event.sessionID, { type: "event", event });
  }, [dispatch]);

  const appendUserMessage = useCallback((sessionId: string, text: string) => {
    const id = newMessageId();
    dispatch(sessionId, { type: "user-message", id, text });
    return id;
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
    setActiveSession,
    getState,
    handleEvent,
    appendUserMessage,
    hydrateSession,
    removeSession,
    reset,
  };
}
