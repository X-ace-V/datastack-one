import type { Event } from "@opencode-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { buildServer } from "../server/app.js";
import { createApprovalGate, type PermissionClient } from "../server/opencode/approvals.js";
import { createQuestionGate, type QuestionClient } from "../server/opencode/questions.js";
import { createToolApprovalGate } from "../server/opencode/tool-approvals.js";

function questionEvent(): Event {
  return {
    type: "question.asked",
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

function appWithQuestion(fail = false) {
  const questionReply = vi.fn(async () => fail
    ? { data: undefined, error: { message: "runtime failed" } }
    : { data: true, error: undefined });
  const questionReject = vi.fn(async () => ({ data: true, error: undefined }));
  const questions = createQuestionGate({
    question: { reply: questionReply, reject: questionReject },
  } as unknown as QuestionClient);
  questions.ingest(questionEvent(), "/Users/parker/warehouse");
  return {
    app: buildServer({ questions }),
    questions,
    questionReply,
    questionReject,
  };
}

describe("POST /api/questions/:requestID", () => {
  it("answers a pending question and resumes it in the captured folder", async () => {
    const { app, questions, questionReply } = appWithQuestion();
    const response = await app.inject({
      method: "POST",
      url: "/api/questions/question_1",
      payload: { action: "answer", answers: [["DuckDB"]] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      requestID: "question_1",
      action: "answer",
      status: "answered",
      answers: [["DuckDB"]],
    });
    expect(questionReply).toHaveBeenCalledWith({
      requestID: "question_1",
      directory: "/Users/parker/warehouse",
      answers: [["DuckDB"]],
    });
    expect(questions.pending()).toEqual([]);
    await app.close();
  });

  it("rejects a question through the runtime", async () => {
    const { app, questionReject } = appWithQuestion();
    const response = await app.inject({
      method: "POST",
      url: "/api/questions/question_1",
      payload: { action: "reject" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("rejected");
    expect(questionReject).toHaveBeenCalledWith({
      requestID: "question_1",
      directory: "/Users/parker/warehouse",
    });
    await app.close();
  });

  it("returns 400 for invalid choices without draining the request", async () => {
    const { app, questions, questionReply } = appWithQuestion();
    const response = await app.inject({
      method: "POST",
      url: "/api/questions/question_1",
      payload: { action: "answer", answers: [["BigQuery"]] },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("does not allow custom");
    expect(questionReply).not.toHaveBeenCalled();
    expect(questions.pending()).toHaveLength(1);
    await app.close();
  });

  it("maps unknown, SDK-failed, and unwired requests honestly", async () => {
    const known = appWithQuestion(true);
    const failed = await known.app.inject({
      method: "POST",
      url: "/api/questions/question_1",
      payload: { action: "answer", answers: [["DuckDB"]] },
    });
    expect(failed.statusCode).toBe(502);
    const unknown = await known.app.inject({
      method: "POST",
      url: "/api/questions/missing",
      payload: { action: "reject" },
    });
    expect(unknown.statusCode).toBe(404);
    await known.app.close();

    const unwired = buildServer();
    const unavailable = await unwired.inject({
      method: "POST",
      url: "/api/questions/question_1",
      payload: { action: "reject" },
    });
    expect(unavailable.statusCode).toBe(503);
    await unwired.close();
  });
});

describe("GET /api/interactions", () => {
  it("recovers pending built-in/custom approvals and questions", async () => {
    const permissionClient = {
      postSessionIdPermissionsPermissionId: async () => ({ data: true, error: undefined }),
    } as unknown as PermissionClient;
    const approvals = createApprovalGate(permissionClient);
    approvals.ingest({
      type: "permission.asked",
      properties: {
        id: "permission_1",
        sessionID: "ses_2",
        permission: "bash",
        patterns: ["pwd"],
        metadata: { command: "pwd" },
      },
    } as unknown as Event);
    const toolApprovals = createToolApprovalGate(() => {});
    toolApprovals.request({ sessionID: "ses_3", tool: "run_transform", metadata: { sql: "SELECT 1" } });
    const { questions } = appWithQuestion();
    const app = buildServer({ approvals, toolApprovals, questions });

    const response = await app.inject({ method: "GET", url: "/api/interactions" });
    expect(response.statusCode).toBe(200);
    expect(response.json().approvals).toHaveLength(2);
    expect(response.json().questions).toEqual([expect.objectContaining({ requestID: "question_1" })]);
    await app.close();
  });

  it("returns empty arrays in a health-only boot", async () => {
    const app = buildServer();
    const response = await app.inject({ method: "GET", url: "/api/interactions" });
    expect(response.json()).toEqual({ approvals: [], questions: [] });
    await app.close();
  });
});
