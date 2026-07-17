// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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
      ev({ ...base, status: "completed", output: "42 rows" }),
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
