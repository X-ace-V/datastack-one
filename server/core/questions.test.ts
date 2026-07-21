import { describe, expect, it } from "vitest";
import {
  QuestionDecisionSchema,
  QuestionRequestSchema,
  toQuestionRequest,
  validateQuestionAnswers,
} from "./questions.js";

const request = QuestionRequestSchema.parse({
  requestID: "question_1",
  sessionID: "ses_1",
  questions: [
    {
      header: "Warehouse",
      question: "Which warehouse should I target?",
      options: [
        { label: "DuckDB", description: "Local analytics" },
        { label: "Snowflake", description: "Cloud warehouse" },
      ],
      custom: false,
    },
    {
      header: "Checks",
      question: "Which checks are required?",
      options: [
        { label: "Freshness", description: "Recent data" },
        { label: "Uniqueness", description: "No duplicates" },
      ],
      multiple: true,
    },
  ],
  messageID: "msg_1",
  callID: "call_1",
});

describe("question contract", () => {
  it("maps a runtime question request including its tool association", () => {
    expect(toQuestionRequest({
      id: "question_1",
      sessionID: "ses_1",
      questions: request.questions,
      tool: { messageID: "msg_1", callID: "call_1" },
    })).toEqual(request);
  });

  it("accepts ordered single, multiple, and default-enabled custom answers", () => {
    expect(validateQuestionAnswers(request, [
      ["DuckDB"],
      ["Freshness", "Use dbt tests"],
    ])).toBeNull();
  });

  it("rejects missing, multiple-on-single, and forbidden custom answers", () => {
    expect(validateQuestionAnswers(request, [["DuckDB"]])).toContain("expected 2");
    expect(validateQuestionAnswers(request, [["DuckDB", "Snowflake"], ["Freshness"]]))
      .toContain("only one");
    expect(validateQuestionAnswers(request, [["BigQuery"], ["Freshness"]]))
      .toContain("does not allow custom");
  });

  it("validates answer and reject API bodies", () => {
    expect(QuestionDecisionSchema.parse({ action: "answer", answers: [["DuckDB"]] }))
      .toEqual({ action: "answer", answers: [["DuckDB"]] });
    expect(QuestionDecisionSchema.parse({ action: "reject" })).toEqual({ action: "reject" });
    expect(QuestionDecisionSchema.safeParse({ action: "answer", answers: [[]] }).success)
      .toBe(false);
  });
});
