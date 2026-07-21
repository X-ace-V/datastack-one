import type { Event } from "@opencode-ai/sdk";
import type { OpencodeClient as V2OpencodeClient } from "@opencode-ai/sdk/v2";
import {
  toQuestionRequest,
  validateQuestionAnswers,
  type QuestionAskedProperties,
  type QuestionDecision,
  type QuestionRejectedProperties,
  type QuestionRepliedProperties,
  type QuestionRequest,
  type QuestionResult,
} from "../core/questions.js";

/** Minimal v2 SDK surface needed to answer OpenCode's interactive question tool. */
export type QuestionClient = Pick<V2OpencodeClient, "question" | "v2">;

export class UnknownQuestionError extends Error {
  constructor(requestID: string) {
    super(`no pending question for request "${requestID}"`);
    this.name = "UnknownQuestionError";
  }
}

export class InvalidQuestionAnswerError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "InvalidQuestionAnswerError";
  }
}

export class QuestionReplyError extends Error {
  constructor(requestID: string, detail: string) {
    super(`failed to answer question "${requestID}": ${detail}`);
    this.name = "QuestionReplyError";
  }
}

interface PendingQuestion {
  request: QuestionRequest;
  directory?: string;
  api: "legacy" | "v2";
}

export interface QuestionGate {
  /** Capture asked events and clear replied/rejected events from the global runtime stream. */
  ingest(event: Event, directory?: string): void;
  pending(): QuestionRequest[];
  get(requestID: string): QuestionRequest | undefined;
  /** Reply/reject through the SDK, preserving the folder root that emitted the request. */
  reply(requestID: string, decision: QuestionDecision): Promise<QuestionResult>;
}

const ASKED_EVENTS = new Set(["question.asked", "question.v2.asked"]);
const REPLIED_EVENTS = new Set(["question.replied", "question.v2.replied"]);
const REJECTED_EVENTS = new Set(["question.rejected", "question.v2.rejected"]);

export function createQuestionGate(client: QuestionClient): QuestionGate {
  const queue = new Map<string, PendingQuestion>();

  return {
    ingest(event, directory) {
      const raw = event as unknown as { type: string; properties: unknown };
      if (ASKED_EVENTS.has(raw.type)) {
        const request = toQuestionRequest(raw.properties as QuestionAskedProperties);
        queue.set(request.requestID, {
          request,
          directory,
          api: raw.type === "question.v2.asked" ? "v2" : "legacy",
        });
        return;
      }
      if (REPLIED_EVENTS.has(raw.type)) {
        queue.delete((raw.properties as QuestionRepliedProperties).requestID);
        return;
      }
      if (REJECTED_EVENTS.has(raw.type)) {
        queue.delete((raw.properties as QuestionRejectedProperties).requestID);
      }
    },

    pending() {
      return [...queue.values()].map((entry) => entry.request);
    },

    get(requestID) {
      return queue.get(requestID)?.request;
    },

    async reply(requestID, decision) {
      const pending = queue.get(requestID);
      if (!pending) throw new UnknownQuestionError(requestID);

      if (decision.action === "answer") {
        const invalid = validateQuestionAnswers(pending.request, decision.answers);
        if (invalid) throw new InvalidQuestionAnswerError(invalid);
        const result = pending.api === "v2"
          ? await client.v2.session.question.reply({
              sessionID: pending.request.sessionID,
              requestID,
              questionV2Reply: { answers: decision.answers },
            })
          : await client.question.reply({
              requestID,
              ...(pending.directory ? { directory: pending.directory } : {}),
              answers: decision.answers,
            });
        if (result.error) {
          throw new QuestionReplyError(requestID, JSON.stringify(result.error));
        }
        queue.delete(requestID);
        return {
          requestID,
          action: "answer",
          status: "answered",
          answers: decision.answers,
        };
      }

      const result = pending.api === "v2"
        ? await client.v2.session.question.reject({
            sessionID: pending.request.sessionID,
            requestID,
          })
        : await client.question.reject({
            requestID,
            ...(pending.directory ? { directory: pending.directory } : {}),
          });
      if (result.error) {
        throw new QuestionReplyError(requestID, JSON.stringify(result.error));
      }
      queue.delete(requestID);
      return { requestID, action: "reject", status: "rejected" };
    },
  };
}
