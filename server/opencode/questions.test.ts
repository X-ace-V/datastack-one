import type { Event } from "@opencode-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import {
  InvalidQuestionAnswerError,
  QuestionReplyError,
  UnknownQuestionError,
  createQuestionGate,
  type QuestionClient,
} from "./questions.js";

function asked(type = "question.asked"): Event {
  return {
    type,
    properties: {
      id: "question_1",
      sessionID: "ses_1",
      questions: [{
        header: "Warehouse",
        question: "Which warehouse?",
        options: [
          { label: "DuckDB", description: "Local" },
          { label: "Snowflake", description: "Cloud" },
        ],
        custom: false,
      }],
      tool: { messageID: "msg_1", callID: "call_1" },
    },
  } as unknown as Event;
}

function mockClient(fail = false) {
  const reply = vi.fn(async () => fail
    ? { data: undefined, error: { message: "runtime boom" } }
    : { data: true, error: undefined });
  const reject = vi.fn(async () => fail
    ? { data: undefined, error: { message: "runtime boom" } }
    : { data: true, error: undefined });
  const v2Reply = vi.fn(async () => ({ data: undefined, error: undefined }));
  const v2Reject = vi.fn(async () => ({ data: undefined, error: undefined }));
  const client = {
    question: { reply, reject },
    v2: { session: { question: { reply: v2Reply, reject: v2Reject } } },
  } as unknown as QuestionClient;
  return { client, reply, reject, v2Reply, v2Reject };
}

describe("createQuestionGate", () => {
  it.each(["question.asked", "question.v2.asked"])(
    "captures %s with its question choices",
    (type) => {
      const { client } = mockClient();
      const gate = createQuestionGate(client);
      gate.ingest(asked(type), "/Users/parker/warehouse");
      expect(gate.pending()).toEqual([expect.objectContaining({
        requestID: "question_1",
        sessionID: "ses_1",
        messageID: "msg_1",
        callID: "call_1",
      })]);
    },
  );

  it("answers with ordered labels in the originating folder and drains", async () => {
    const { client, reply } = mockClient();
    const gate = createQuestionGate(client);
    gate.ingest(asked(), "/Users/parker/warehouse");

    await expect(gate.reply("question_1", { action: "answer", answers: [["DuckDB"]] }))
      .resolves.toEqual({
        requestID: "question_1",
        action: "answer",
        status: "answered",
        answers: [["DuckDB"]],
      });
    expect(reply).toHaveBeenCalledWith({
      requestID: "question_1",
      directory: "/Users/parker/warehouse",
      answers: [["DuckDB"]],
    });
    expect(gate.pending()).toEqual([]);
  });

  it("rejects through the SDK in the originating folder", async () => {
    const { client, reject } = mockClient();
    const gate = createQuestionGate(client);
    gate.ingest(asked(), "/Users/parker/warehouse");
    await expect(gate.reply("question_1", { action: "reject" })).resolves.toMatchObject({
      status: "rejected",
    });
    expect(reject).toHaveBeenCalledWith({
      requestID: "question_1",
      directory: "/Users/parker/warehouse",
    });
  });

  it("uses the session-scoped endpoint for question.v2 events", async () => {
    const { client, reply, v2Reply, v2Reject } = mockClient();
    const gate = createQuestionGate(client);
    gate.ingest(asked("question.v2.asked"), "/Users/parker/warehouse");
    await gate.reply("question_1", { action: "answer", answers: [["DuckDB"]] });
    expect(reply).not.toHaveBeenCalled();
    expect(v2Reply).toHaveBeenCalledWith({
      sessionID: "ses_1",
      requestID: "question_1",
      questionV2Reply: { answers: [["DuckDB"]] },
    });

    gate.ingest(asked("question.v2.asked"));
    await gate.reply("question_1", { action: "reject" });
    expect(v2Reject).toHaveBeenCalledWith({ sessionID: "ses_1", requestID: "question_1" });
  });

  it("validates answers before calling the runtime", async () => {
    const { client, reply } = mockClient();
    const gate = createQuestionGate(client);
    gate.ingest(asked());
    await expect(gate.reply("question_1", { action: "answer", answers: [["BigQuery"]] }))
      .rejects.toBeInstanceOf(InvalidQuestionAnswerError);
    expect(reply).not.toHaveBeenCalled();
    expect(gate.get("question_1")).toBeTruthy();
  });

  it("keeps a question retryable after an SDK failure", async () => {
    const { client } = mockClient(true);
    const gate = createQuestionGate(client);
    gate.ingest(asked());
    await expect(gate.reply("question_1", { action: "answer", answers: [["DuckDB"]] }))
      .rejects.toBeInstanceOf(QuestionReplyError);
    expect(gate.get("question_1")).toBeTruthy();
  });

  it("rejects unknown ids and clears requests resolved by another client", async () => {
    const { client } = mockClient();
    const gate = createQuestionGate(client);
    await expect(gate.reply("missing", { action: "reject" }))
      .rejects.toBeInstanceOf(UnknownQuestionError);
    gate.ingest(asked("question.v2.asked"));
    gate.ingest({
      type: "question.v2.replied",
      properties: { sessionID: "ses_1", requestID: "question_1", answers: [["DuckDB"]] },
    } as unknown as Event);
    expect(gate.pending()).toEqual([]);
  });
});
