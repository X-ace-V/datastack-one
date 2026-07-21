// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  createEmptySessionState,
  reduce,
  useSessionStore,
  type AssistantMessage,
  type NormalizedEvent,
  type SessionLiveState,
  type StoreAction,
} from "./sessionStore";

/**
 * V2.1 — the per-session live-state store. The bulk asserts the PURE reducer (`reduce`): it
 * folds the normalized SSE stream into an ordered transcript, upserting streamed parts by id,
 * surfacing inline approvals, suppressing the runtime's echo of the user's own prompt, and
 * never mutating its input. A smaller set drives the hook to prove active-session mirroring:
 * only the active session flows to React state; background sessions accumulate in the Map.
 */

const SID = "ses_1";

/** Fold a sequence of actions from an empty state — the reducer's real usage shape. */
function run(actions: StoreAction[], start = createEmptySessionState()): SessionLiveState {
  return actions.reduce(reduce, start);
}

function ev(event: NormalizedEvent): StoreAction {
  return { type: "event", event };
}

/** The single assistant turn in a transcript (fails the test if there is not exactly one). */
function assistant(state: SessionLiveState): AssistantMessage {
  const msgs = state.messages.filter(
    (m): m is AssistantMessage => m.role === "assistant",
  );
  expect(msgs).toHaveLength(1);
  const only = msgs[0];
  if (!only) throw new Error("expected exactly one assistant message");
  return only;
}

describe("reduce — user turns", () => {
  it("appends the user message, marks the turn working, and arms echo suppression", () => {
    const s = run([{ type: "user-message", id: "u1", text: "profile this" }]);
    expect(s.messages).toEqual([{ role: "user", id: "u1", content: "profile this" }]);
    expect(s.isWorking).toBe(true);
    expect(s.pendingEchoes).toEqual(["profile this"]);
    expect(s.error).toBeNull();
  });

  it("clears a prior error when a new user turn starts", () => {
    const s = run([
      ev({ kind: "error", sessionID: SID, message: "boom" }),
      { type: "user-message", id: "u1", text: "retry" },
    ]);
    expect(s.error).toBeNull();
  });

  it("keeps attachment references on the user turn", () => {
    const attachments = [{ name: "loans", kind: "csv" }];
    const s = run([{ type: "user-message", id: "u1", text: "", attachments }]);
    expect(s.messages[0]).toEqual({ role: "user", id: "u1", content: "", attachments });
  });
});

describe("reduce — composer and folder state", () => {
  it("updates draft, attachment queue, and connected folder without touching the transcript", () => {
    const file = new File(["id\n1\n"], "loans.csv");
    const attachment = {
      id: "a1",
      file,
      name: file.name,
      size: file.size,
      status: "uploading" as const,
    };
    const state = run([
      { type: "set-draft", text: "profile this" },
      { type: "add-attachments", attachments: [attachment] },
      {
        type: "folder",
        folder: {
          sessionId: SID,
          name: "pipeline",
          path: "/allowed/pipeline",
          workspaceRoot: true,
          connectedAt: "2026-07-19",
        },
        files: [
          {
            path: "models/daily.sql",
            name: "daily.sql",
            kind: "sql",
            size: 8,
            modifiedAt: "2026-07-19",
            queryable: false,
          },
        ],
      },
    ]);
    expect(state.draft).toBe("profile this");
    expect(state.attachments).toEqual([attachment]);
    expect(state.folder?.name).toBe("pipeline");
    expect(state.workspaceFiles[0]?.path).toBe("models/daily.sql");
    expect(state.messages).toEqual([]);
  });

  it("maps OpenCode busy/retry/idle statuses onto a session's working state", () => {
    const busy = run([ev({ kind: "session_status", sessionID: SID, status: "busy" })]);
    expect(busy.isWorking).toBe(true);
    const retry = reduce(busy, ev({
      kind: "session_status",
      sessionID: SID,
      status: "retry",
      message: "provider retry",
    }));
    expect(retry.isWorking).toBe(true);
    expect(retry.error).toBe("provider retry");
    expect(reduce(retry, ev({ kind: "session_status", sessionID: SID, status: "idle" })).isWorking)
      .toBe(false);
  });
});

describe("reduce — streamed text", () => {
  it("creates an assistant message and upserts the same part in place as text accumulates", () => {
    const s = run([
      ev({ kind: "text", sessionID: SID, messageID: "m1", partID: "p1", text: "The " }),
      ev({ kind: "text", sessionID: SID, messageID: "m1", partID: "p1", text: "The answer" }),
    ]);
    const a = assistant(s);
    expect(a.id).toBe("m1");
    // Full accumulated text replaces in place — one block, not two.
    expect(a.blocks).toEqual([{ kind: "text", partID: "p1", text: "The answer" }]);
  });

  it("keeps distinct parts as separate blocks in first-seen order", () => {
    const s = run([
      ev({ kind: "text", sessionID: SID, messageID: "m1", partID: "p1", text: "first" }),
      ev({ kind: "text", sessionID: SID, messageID: "m1", partID: "p2", text: "second" }),
    ]);
    expect(assistant(s).blocks).toEqual([
      { kind: "text", partID: "p1", text: "first" },
      { kind: "text", partID: "p2", text: "second" },
    ]);
  });

  it("groups parts by messageID into distinct assistant turns", () => {
    const s = run([
      ev({ kind: "text", sessionID: SID, messageID: "m1", partID: "p1", text: "turn one" }),
      ev({ kind: "idle", sessionID: SID }),
      ev({ kind: "text", sessionID: SID, messageID: "m2", partID: "p2", text: "turn two" }),
    ]);
    const turns = s.messages.filter((m) => m.role === "assistant") as AssistantMessage[];
    expect(turns.map((t) => t.id)).toEqual(["m1", "m2"]);
  });
});

describe("reduce — reasoning and reading order", () => {
  it("interleaves reasoning and text blocks in arrival order within one turn", () => {
    const s = run([
      ev({ kind: "reasoning", sessionID: SID, messageID: "m1", partID: "r1", text: "planning" }),
      ev({ kind: "text", sessionID: SID, messageID: "m1", partID: "t1", text: "here it is" }),
    ]);
    expect(assistant(s).blocks.map((b) => b.kind)).toEqual(["reasoning", "text"]);
  });
});

describe("reduce — tool calls", () => {
  it("upserts a tool block by callID across its status lifecycle, keeping its position", () => {
    const base = {
      kind: "tool" as const,
      sessionID: SID,
      messageID: "m1",
      partID: "tp1",
      callID: "c1",
      tool: "run_query",
    };
    const s = run([
      ev({ ...base, status: "pending" }),
      ev({ kind: "text", sessionID: SID, messageID: "m1", partID: "t1", text: "running it" }),
      ev({ ...base, status: "running", title: "querying" }),
      ev({
        ...base,
        status: "completed",
        output: "42 rows",
        metadata: { result: { columns: [], rows: [], rowCount: 0, truncated: false } },
      }),
    ]);
    const blocks = assistant(s).blocks;
    // The tool stays at index 0 (where it first appeared); the text follows it.
    expect(blocks).toHaveLength(2);
    const [tool, text] = blocks;
    expect(tool?.kind).toBe("tool");
    if (tool?.kind === "tool") {
      expect(tool.callID).toBe("c1");
      expect(tool.status).toBe("completed");
      expect(tool.output).toBe("42 rows");
      // The structured metadata (the data-panel payload) is carried through onto the block.
      expect(tool.metadata).toEqual({
        result: { columns: [], rows: [], rowCount: 0, truncated: false },
      });
    }
    expect(text?.kind).toBe("text");
  });
});

describe("reduce — inline approvals (FR10)", () => {
  it("attaches a pending pill to the turn holding the gated tool call and tracks it", () => {
    const s = run([
      ev({
        kind: "tool",
        sessionID: SID,
        messageID: "m1",
        partID: "tp1",
        callID: "c1",
        tool: "run_transform",
        status: "running",
      }),
      ev({
        kind: "approval",
        sessionID: SID,
        requestID: "req1",
        type: "run_transform",
        metadata: { sql: "CREATE TABLE marts.x AS SELECT 1" },
        callID: "c1",
      }),
    ]);
    const a = assistant(s);
    expect(a.id).toBe("m1"); // hosted on the tool's turn, not a new one
    const pill = a.blocks.find((b) => b.kind === "approval");
    expect(pill).toMatchObject({
      kind: "approval",
      requestID: "req1",
      approvalType: "run_transform",
      status: "pending",
      metadata: { sql: "CREATE TABLE marts.x AS SELECT 1" },
    });
    expect(s.pendingApprovals).toHaveLength(1);
    expect(s.pendingApprovals[0]?.requestID).toBe("req1");
  });

  it("resolves the pill and drops the pending gate on approval_resolved", () => {
    const s = run([
      ev({
        kind: "approval",
        sessionID: SID,
        requestID: "req1",
        type: "run_transform",
        metadata: { sql: "SELECT 1" },
        callID: "c1",
      }),
      ev({ kind: "approval_resolved", sessionID: SID, requestID: "req1", status: "approved" }),
    ]);
    const pill = assistant(s).blocks.find((b) => b.kind === "approval");
    expect(pill).toMatchObject({ status: "approved" });
    expect(s.pendingApprovals).toEqual([]);
  });

  it("does not double-count a re-delivered (replayed) approval", () => {
    const approval: NormalizedEvent = {
      kind: "approval",
      sessionID: SID,
      requestID: "req1",
      type: "run_transform",
      metadata: {},
    };
    const s = run([ev(approval), ev(approval)]);
    expect(s.pendingApprovals).toHaveLength(1);
  });

  it("hosts an approval that arrives before any assistant content on a new turn", () => {
    const s = run([
      ev({
        kind: "approval",
        sessionID: SID,
        requestID: "req1",
        type: "bash",
        metadata: { command: "echo hi" },
      }),
    ]);
    expect(assistant(s).blocks.find((b) => b.kind === "approval")).toBeTruthy();
  });
});

describe("reduce — interactive questions", () => {
  const question: NormalizedEvent = {
    kind: "question",
    sessionID: SID,
    requestID: "question_1",
    messageID: "m1",
    callID: "call_1",
    questions: [{
      header: "Warehouse",
      question: "Which warehouse?",
      options: [{ label: "DuckDB", description: "Local" }],
    }],
  };

  it("attaches the controls to the owning tool turn and tracks pending input", () => {
    const state = run([
      ev({
        kind: "tool",
        sessionID: SID,
        messageID: "m1",
        partID: "part_1",
        callID: "call_1",
        tool: "question",
        status: "running",
      }),
      ev(question),
    ]);
    expect(assistant(state).id).toBe("m1");
    expect(assistant(state).blocks.find((candidate) => candidate.kind === "question"))
      .toMatchObject({ requestID: "question_1", status: "pending" });
    expect(state.pendingQuestions).toHaveLength(1);
    expect(state.isWorking).toBe(true);
  });

  it("is idempotent on recovery and records the terminal answer", () => {
    const state = run([
      ev(question),
      ev(question),
      ev({
        kind: "question_resolved",
        sessionID: SID,
        requestID: "question_1",
        status: "answered",
        answers: [["DuckDB"]],
      }),
    ]);
    expect(state.pendingQuestions).toEqual([]);
    const blocks = assistant(state).blocks.filter((candidate) => candidate.kind === "question");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ status: "answered", answers: [["DuckDB"]] });
  });

  it("keeps background sessions independent and marks them waiting for input", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string) => ({
      ok: true,
      json: async () => input === "/api/sessions/status"
        ? { statuses: {} }
        : { sessions: [{
            id: SID,
            title: "Warehouse setup",
            model: null,
            createdAt: "2026-07-20",
            updatedAt: "2026-07-20",
          }] },
    })));
    try {
      const { result } = renderHook(() => useSessionStore());
      await act(async () => result.current.loadSessions());
      act(() => {
        result.current.setActiveSession("another_session");
        result.current.handleEvent(question);
      });
      expect(result.current.activeSessionId).toBe("another_session");
      expect(result.current.sessions[0]?.status).toBe("waiting_input");
      expect(result.current.getState(SID)?.pendingQuestions).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("reduce — turn lifecycle", () => {
  it("idle ends the turn and clears echo bookkeeping", () => {
    const s = run([
      { type: "user-message", id: "u1", text: "hi" },
      ev({ kind: "idle", sessionID: SID }),
    ]);
    expect(s.isWorking).toBe(false);
    expect(s.pendingEchoes).toEqual([]);
    expect(s.echoMessageIds).toEqual([]);
  });

  it("error surfaces the message and ends the turn", () => {
    const s = run([
      { type: "user-message", id: "u1", text: "hi" },
      ev({ kind: "error", sessionID: SID, message: "model unavailable" }),
    ]);
    expect(s.error).toBe("model unavailable");
    expect(s.isWorking).toBe(false);
  });
});

describe("reduce — user-prompt echo suppression", () => {
  it("drops the runtime's role-less echo of the prompt but renders the real answer", () => {
    const s = run([
      { type: "user-message", id: "u1", text: "which branch is overdue?" },
      // The runtime re-streams the user's prompt as a text event (its own messageID).
      ev({
        kind: "text",
        sessionID: SID,
        messageID: "m_user",
        partID: "pu",
        text: "which branch is overdue?",
      }),
      // The assistant's genuine answer (a different messageID).
      ev({ kind: "text", sessionID: SID, messageID: "m_asst", partID: "pa", text: "North." }),
    ]);
    // Exactly one user turn and one assistant turn — no phantom echo bubble.
    expect(s.messages.filter((m) => m.role === "user")).toHaveLength(1);
    const a = assistant(s);
    expect(a.id).toBe("m_asst");
    expect(a.blocks).toEqual([{ kind: "text", partID: "pa", text: "North." }]);
    expect(s.echoMessageIds).toContain("m_user");
  });

  it("suppresses every part of a prompt that echoes across multiple deltas", () => {
    const s = run([
      { type: "user-message", id: "u1", text: "hello world" },
      ev({ kind: "text", sessionID: SID, messageID: "m_user", partID: "pu", text: "hello" }),
      ev({ kind: "text", sessionID: SID, messageID: "m_user", partID: "pu", text: "hello world" }),
    ]);
    // No assistant message was created from the echo.
    expect(s.messages.filter((m) => m.role === "assistant")).toHaveLength(0);
    expect(s.echoMessageIds).toEqual(["m_user"]);
  });
});

describe("reduce — immutability", () => {
  it("returns a new state and never mutates the input", () => {
    const before = run([
      ev({ kind: "text", sessionID: SID, messageID: "m1", partID: "p1", text: "a" }),
    ]);
    const snapshot = JSON.stringify(before);
    const after = reduce(before, ev({
      kind: "text",
      sessionID: SID,
      messageID: "m1",
      partID: "p1",
      text: "ab",
    }));
    expect(after).not.toBe(before);
    expect(after.messages).not.toBe(before.messages);
    // The prior state object is untouched.
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it("returns the SAME state object when an event changes nothing (suppressed echo part)", () => {
    const base = run([
      { type: "user-message", id: "u1", text: "hi" },
      ev({ kind: "text", sessionID: SID, messageID: "m_user", partID: "pu", text: "hi" }),
    ]);
    // A further part of the already-bound echo messageID is a no-op.
    const next = reduce(base, ev({
      kind: "text",
      sessionID: SID,
      messageID: "m_user",
      partID: "pu",
      text: "hi",
    }));
    expect(next).toBe(base);
  });
});

describe("reduce — hydrate from persisted history (V6.2)", () => {
  it("reconstructs user turns and an assistant turn's tool-block history", () => {
    const state = reduce(createEmptySessionState(), {
      type: "hydrate",
      messages: [
        { role: "user", id: "u1", content: "which branch?" },
        {
          role: "assistant",
          id: "a1",
          content: "The north branch.",
          blocks: [
            { kind: "reasoning", partID: "r1", text: "I'll query it." },
            {
              kind: "tool",
              callID: "c1",
              tool: "run_query",
              status: "completed",
              input: { sql: "SELECT branch FROM loans" },
              output: "north",
            },
            { kind: "text", partID: "p1", text: "The north branch." },
          ],
        },
      ],
    });

    expect(state.messages).toHaveLength(2);
    expect(state.messages[0]).toEqual({ role: "user", id: "u1", content: "which branch?" });
    const asst = state.messages[1] as AssistantMessage;
    expect(asst.role).toBe("assistant");
    expect(asst.id).toBe("a1");
    // The tool card and its reading-order neighbours reconstruct exactly.
    expect(asst.blocks.map((b) => b.kind)).toEqual(["reasoning", "tool", "text"]);
    expect(asst.blocks[1]).toMatchObject({ kind: "tool", tool: "run_query", status: "completed" });
    // A reopened session is idle with no pending gates.
    expect(state.isWorking).toBe(false);
    expect(state.pendingApprovals).toEqual([]);
  });

  it("falls back to a single text block for an assistant row saved without blocks", () => {
    const state = reduce(createEmptySessionState(), {
      type: "hydrate",
      messages: [{ role: "assistant", id: "a1", content: "hello" }],
    });
    const asst = state.messages[0] as AssistantMessage;
    expect(asst.blocks).toEqual([{ kind: "text", partID: "a1:text", text: "hello" }]);
  });
});

describe("useSessionStore — hydrateSession (V6.2)", () => {
  it("seeds an unseen session's transcript from persisted history", () => {
    const { result } = renderHook(() => useSessionStore());
    act(() =>
      result.current.hydrateSession("ses_a", [
        { role: "user", id: "u1", content: "hi" },
        {
          role: "assistant",
          id: "a1",
          content: "hey",
          blocks: [{ kind: "text", partID: "p1", text: "hey" }],
        },
      ]),
    );
    act(() => result.current.setActiveSession("ses_a"));
    expect(result.current.activeState.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
    ]);
  });

  it("does not clobber a session that already has live/streamed state", () => {
    const { result } = renderHook(() => useSessionStore());
    act(() => result.current.setActiveSession("ses_a"));
    act(() => {
      result.current.appendUserMessage("ses_a", "in-flight prompt");
    });
    // A late reopen fetch tries to hydrate the same session — it must be ignored.
    act(() =>
      result.current.hydrateSession("ses_a", [
        { role: "user", id: "stale", content: "stale history" },
      ]),
    );
    expect(result.current.activeState.messages).toEqual([
      { role: "user", id: expect.any(String), content: "in-flight prompt" },
    ]);
  });
});

describe("useSessionStore — active-session mirroring", () => {
  it("mirrors only the active session to React state; background sessions accumulate", () => {
    const { result } = renderHook(() => useSessionStore());

    act(() => result.current.setActiveSession("ses_a"));

    // Event for the ACTIVE session flows to activeState.
    act(() =>
      result.current.handleEvent({
        kind: "text",
        sessionID: "ses_a",
        messageID: "m1",
        partID: "p1",
        text: "active answer",
      }),
    );
    expect(result.current.activeState.messages).toHaveLength(1);

    // Event for a BACKGROUND session updates the Map but not activeState.
    act(() =>
      result.current.handleEvent({
        kind: "text",
        sessionID: "ses_b",
        messageID: "m2",
        partID: "p2",
        text: "background answer",
      }),
    );
    expect(result.current.activeState.messages).toHaveLength(1); // unchanged
    expect(result.current.getState("ses_b")?.messages).toHaveLength(1); // accumulated

    // Switching to the background session mirrors its accumulated state in.
    act(() => result.current.setActiveSession("ses_b"));
    expect(result.current.activeSessionId).toBe("ses_b");
    const block = (result.current.activeState.messages[0] as AssistantMessage).blocks[0];
    expect(block).toMatchObject({ kind: "text", text: "background answer" });
  });

  it("appendUserMessage records the user turn on the active session and returns its id", () => {
    const { result } = renderHook(() => useSessionStore());
    act(() => result.current.setActiveSession("ses_a"));

    let id = "";
    act(() => {
      id = result.current.appendUserMessage("ses_a", "hello agent");
    });
    expect(id).toBeTruthy();
    expect(result.current.activeState.messages).toEqual([
      { role: "user", id, content: "hello agent" },
    ]);
    expect(result.current.activeState.isWorking).toBe(true);
  });

  it("keeps drafts and attachment queues owned by the session while switching", () => {
    const { result } = renderHook(() => useSessionStore());
    act(() => {
      result.current.setActiveSession("ses_a");
      result.current.setDraft("ses_a", "alpha draft");
    });
    act(() => {
      result.current.setActiveSession("ses_b");
      result.current.setDraft("ses_b", "beta draft");
    });
    expect(result.current.activeState.draft).toBe("beta draft");
    expect(result.current.getState("ses_a")?.draft).toBe("alpha draft");
    act(() => result.current.setActiveSession("ses_a"));
    expect(result.current.activeState.draft).toBe("alpha draft");
  });

  it("removeSession drops state and clears activeState when it was active", () => {
    const { result } = renderHook(() => useSessionStore());
    act(() => result.current.setActiveSession("ses_a"));
    act(() => {
      result.current.appendUserMessage("ses_a", "hi");
    });
    expect(result.current.activeState.messages).toHaveLength(1);

    act(() => result.current.removeSession("ses_a"));
    expect(result.current.getState("ses_a")).toBeUndefined();
    expect(result.current.activeSessionId).toBeNull();
    expect(result.current.activeState).toEqual(createEmptySessionState());
  });
});

describe("useSessionStore — central background session index", () => {
  it("starts a new active session in the selected folder and preserves the previous chat", async () => {
    const created = {
      id: "ses_folder",
      title: "New session",
      model: null,
      createdAt: "2026-07-19",
      updatedAt: "2026-07-19",
    };
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      if (input === "/api/sessions" && init?.method === "POST") {
        return { ok: true, json: async () => created };
      }
      if (input === "/api/sessions/ses_folder/folder") {
        return {
          ok: true,
          json: async () => ({
            folder: {
              sessionId: "ses_folder",
              name: "pipeline",
              path: "/allowed/pipeline",
              workspaceRoot: true,
              connectedAt: "2026-07-19",
            },
            files: [],
          }),
        };
      }
      throw new Error(`unexpected request ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const { result } = renderHook(() => useSessionStore());
      act(() => {
        result.current.setActiveSession("ses_previous");
        result.current.setDraft("ses_previous", "keep this draft");
      });
      await act(async () => {
        await result.current.openFolderSession("/allowed/pipeline");
      });

      expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({
        folderPath: "/allowed/pipeline",
      });
      expect(result.current.activeSessionId).toBe("ses_folder");
      expect(result.current.activeState.folder).toMatchObject({
        path: "/allowed/pipeline",
        workspaceRoot: true,
      });
      expect(result.current.getState("ses_previous")?.draft).toBe("keep this draft");
      expect(result.current.sessions[0]).toMatchObject({ id: "ses_folder", status: "idle" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("recovers busy sessions and applies an OpenCode title event that arrived before the list", async () => {
    const session = {
      id: "ses_a",
      title: "New session",
      model: null,
      createdAt: "2026-07-19",
      updatedAt: "2026-07-19",
    };
    vi.stubGlobal("fetch", vi.fn(async (input: string) => ({
      ok: true,
      json: async () =>
        input === "/api/sessions/status"
          ? { statuses: { ses_a: { type: "busy" } } }
          : { sessions: [session] },
    })));
    try {
      const { result } = renderHook(() => useSessionStore());
      act(() =>
        result.current.handleEvent({
          kind: "session_updated",
          sessionID: "ses_a",
          title: "Profile customer loans",
        }),
      );
      await act(async () => {
        await result.current.loadSessions();
      });
      expect(result.current.sessions).toEqual([
        expect.objectContaining({
          id: "ses_a",
          title: "Profile customer loans",
          status: "working",
        }),
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("updates an inactive session's visible title and status from the global event stream", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string) => ({
      ok: true,
      json: async () =>
        input === "/api/sessions/status"
          ? { statuses: {} }
          : {
              sessions: [
                {
                  id: "ses_background",
                  title: "New session",
                  model: null,
                  createdAt: "2026-07-19",
                  updatedAt: "2026-07-19",
                },
              ],
            },
    })));
    try {
      const { result } = renderHook(() => useSessionStore());
      await act(async () => {
        await result.current.loadSessions();
      });
      act(() => {
        result.current.setActiveSession("ses_foreground");
        result.current.handleEvent({
          kind: "session_updated",
          sessionID: "ses_background",
          title: "Build daily revenue model",
        });
        result.current.handleEvent({
          kind: "session_status",
          sessionID: "ses_background",
          status: "busy",
        });
      });
      expect(result.current.activeSessionId).toBe("ses_foreground");
      expect(result.current.sessions[0]).toMatchObject({
        id: "ses_background",
        title: "Build daily revenue model",
        status: "working",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
