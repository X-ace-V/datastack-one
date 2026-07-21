import { z } from "zod";

/** One option offered by OpenCode's interactive `question` tool. */
export const QuestionOptionSchema = z.object({
  label: z.string().min(1),
  description: z.string(),
});
export type QuestionOption = z.infer<typeof QuestionOptionSchema>;

/** One prompt inside a question request. `custom` defaults to true in OpenCode. */
export const QuestionInfoSchema = z.object({
  question: z.string().min(1),
  header: z.string().min(1),
  options: z.array(QuestionOptionSchema),
  multiple: z.boolean().optional(),
  custom: z.boolean().optional(),
});
export type QuestionInfo = z.infer<typeof QuestionInfoSchema>;

/** A still-pending OpenCode question request awaiting user input. */
export const QuestionRequestSchema = z.object({
  requestID: z.string().min(1),
  sessionID: z.string().min(1),
  questions: z.array(QuestionInfoSchema).min(1),
  messageID: z.string().optional(),
  callID: z.string().optional(),
});
export type QuestionRequest = z.infer<typeof QuestionRequestSchema>;

/** Request body for `POST /api/questions/:requestID`. */
export const QuestionDecisionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("answer"),
    answers: z.array(z.array(z.string().trim().min(1)).min(1)).min(1),
  }),
  z.object({ action: z.literal("reject") }),
]);
export type QuestionDecision = z.infer<typeof QuestionDecisionSchema>;

/** Result returned after the runtime accepts a question answer or rejection. */
export const QuestionResultSchema = z.object({
  requestID: z.string().min(1),
  action: z.enum(["answer", "reject"]),
  status: z.enum(["answered", "rejected"]),
  answers: z.array(z.array(z.string())).optional(),
});
export type QuestionResult = z.infer<typeof QuestionResultSchema>;

/** Live OpenCode `question.asked` / `question.v2.asked` payload. */
export interface QuestionAskedProperties {
  id: string;
  sessionID: string;
  questions: QuestionInfo[];
  tool?: { messageID: string; callID: string };
}

/** Live OpenCode answered-question payload. */
export interface QuestionRepliedProperties {
  sessionID: string;
  requestID: string;
  answers: string[][];
}

/** Live OpenCode rejected-question payload. */
export interface QuestionRejectedProperties {
  sessionID: string;
  requestID: string;
}

/** Map and validate the runtime event payload into the platform wire contract. */
export function toQuestionRequest(props: QuestionAskedProperties): QuestionRequest {
  return QuestionRequestSchema.parse({
    requestID: props.id,
    sessionID: props.sessionID,
    questions: props.questions,
    messageID: props.tool?.messageID,
    callID: props.tool?.callID,
  });
}

/**
 * Validate answers against the exact choices the runtime asked. OpenCode enables a custom
 * free-text choice unless `custom: false`, and a non-multiple question accepts one answer.
 */
export function validateQuestionAnswers(
  request: QuestionRequest,
  answers: string[][],
): string | null {
  if (answers.length !== request.questions.length) {
    return `expected ${request.questions.length} answer set(s), received ${answers.length}`;
  }
  for (let index = 0; index < request.questions.length; index += 1) {
    const question = request.questions[index]!;
    const selected = answers[index]!;
    if (selected.length === 0) return `question ${index + 1} requires an answer`;
    if (!question.multiple && selected.length !== 1) {
      return `question ${index + 1} accepts only one answer`;
    }
    if (question.custom === false) {
      const offered = new Set(question.options.map((option) => option.label));
      const unknown = selected.find((answer) => !offered.has(answer));
      if (unknown !== undefined) {
        return `question ${index + 1} does not allow custom answer "${unknown}"`;
      }
    }
  }
  return null;
}
