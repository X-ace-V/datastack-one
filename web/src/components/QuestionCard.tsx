import { useMemo, useState } from "react";
import { answerQuestion } from "../lib/api";
import type { InlineBlock, QuestionStatus } from "../store/sessionStore";

export type QuestionBlock = Extract<InlineBlock, { kind: "question" }>;

export interface QuestionCardProps {
  block: QuestionBlock;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Interactive UI for OpenCode's blocking `question` tool. */
export function QuestionCard({ block }: QuestionCardProps) {
  const [selected, setSelected] = useState<string[][]>(() => block.questions.map(() => []));
  const [custom, setCustom] = useState<string[]>(() => block.questions.map(() => ""));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [optimistic, setOptimistic] = useState<QuestionStatus | null>(null);

  const status = block.status !== "pending" ? block.status : optimistic ?? "pending";
  const answers = useMemo(
    () => block.questions.map((question, index) => {
      const own = custom[index]?.trim() ?? "";
      if (question.multiple) {
        return own ? [...(selected[index] ?? []), own] : selected[index] ?? [];
      }
      return own ? [own] : selected[index] ?? [];
    }),
    [block.questions, custom, selected],
  );
  const complete = answers.every((answer) => answer.length > 0);

  const toggle = (questionIndex: number, label: string, multiple: boolean) => {
    setSelected((current) => current.map((values, index) => {
      if (index !== questionIndex) return values;
      if (!multiple) return [label];
      return values.includes(label)
        ? values.filter((value) => value !== label)
        : [...values, label];
    }));
    if (!multiple) {
      setCustom((current) => current.map((value, index) =>
        index === questionIndex ? "" : value,
      ));
    }
  };

  const updateCustom = (questionIndex: number, value: string, multiple: boolean) => {
    setCustom((current) => current.map((entry, index) =>
      index === questionIndex ? value : entry,
    ));
    if (!multiple && value.trim()) {
      setSelected((current) => current.map((entry, index) =>
        index === questionIndex ? [] : entry,
      ));
    }
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await answerQuestion(block.requestID, { action: "answer", answers });
      setOptimistic("answered");
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  const reject = async () => {
    setBusy(true);
    setError(null);
    try {
      await answerQuestion(block.requestID, { action: "reject" });
      setOptimistic("rejected");
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      data-role="question"
      data-status={status}
      className="overflow-hidden rounded-2xl border border-violet-200 bg-white shadow-lg shadow-violet-950/5"
    >
      <div className="flex items-center gap-3 border-b border-violet-100 bg-violet-50/70 px-4 py-3">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-violet-600 text-white" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" stroke="currentColor" strokeWidth="2">
            <path d="M9.5 9a2.5 2.5 0 1 1 3.8 2.14c-.8.5-1.3 1.05-1.3 2.1" />
            <path d="M12 17.5h.01" />
            <circle cx="12" cy="12" r="9" />
          </svg>
        </span>
        <div>
          <h3 className="text-sm font-semibold text-slate-900">The agent needs your input</h3>
          <p className="text-xs text-slate-500">Answer to continue this session.</p>
        </div>
        <span className={`ml-auto rounded-full px-2.5 py-1 text-[11px] font-semibold ${
          status === "pending"
            ? "bg-amber-100 text-amber-700"
            : status === "answered"
              ? "bg-emerald-100 text-emerald-700"
              : "bg-slate-100 text-slate-600"
        }`}>
          {status === "pending" ? "Waiting" : status === "answered" ? "Answered" : "Skipped"}
        </span>
      </div>

      {status === "pending" ? (
        <div className="space-y-5 p-4">
          {block.questions.map((question, questionIndex) => (
            <fieldset key={`${block.requestID}:${questionIndex}`} className="space-y-2.5">
              <legend className="w-full">
                <span className="block text-[11px] font-bold uppercase tracking-[0.12em] text-violet-600">
                  {question.header}
                </span>
                <span className="mt-1 block text-sm font-medium leading-6 text-slate-800">
                  {question.question}
                </span>
                {question.multiple && (
                  <span className="mt-0.5 block text-xs text-slate-400">Select all that apply</span>
                )}
              </legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {question.options.map((option) => {
                  const checked = selected[questionIndex]?.includes(option.label) ?? false;
                  return (
                    <label
                      key={option.label}
                      className={`flex cursor-pointer gap-3 rounded-xl border px-3 py-2.5 transition ${
                        checked
                          ? "border-violet-400 bg-violet-50 ring-1 ring-violet-200"
                          : "border-slate-200 bg-white hover:border-violet-200 hover:bg-slate-50"
                      }`}
                    >
                      <input
                        type={question.multiple ? "checkbox" : "radio"}
                        name={`${block.requestID}:${questionIndex}`}
                        value={option.label}
                        checked={checked}
                        onChange={() => toggle(questionIndex, option.label, question.multiple === true)}
                        className="mt-1 accent-violet-600"
                      />
                      <span className="min-w-0">
                        <span className="block text-sm font-semibold text-slate-800">{option.label}</span>
                        <span className="block text-xs leading-5 text-slate-500">{option.description}</span>
                      </span>
                    </label>
                  );
                })}
              </div>
              {question.custom !== false && (
                <label className="block">
                  <span className="sr-only">Custom answer for {question.header}</span>
                  <input
                    type="text"
                    value={custom[questionIndex] ?? ""}
                    onChange={(event) => updateCustom(
                      questionIndex,
                      event.target.value,
                      question.multiple === true,
                    )}
                    placeholder="Type your own answer"
                    className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-800 outline-none transition placeholder:text-slate-400 focus:border-violet-400 focus:bg-white focus:ring-2 focus:ring-violet-100"
                  />
                </label>
              )}
            </fieldset>
          ))}

          {error && <p role="alert" className="text-xs text-red-600">{error}</p>}
          <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
            <button
              type="button"
              onClick={() => void submit()}
              disabled={busy || !complete}
              className="rounded-xl bg-slate-950 px-4 py-2 text-xs font-semibold text-white transition hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? "Submitting…" : "Continue"}
            </button>
            <button
              type="button"
              onClick={() => void reject()}
              disabled={busy}
              className="rounded-xl px-3 py-2 text-xs font-semibold text-slate-500 transition hover:bg-slate-100 hover:text-slate-700 disabled:opacity-40"
            >
              Skip question
            </button>
          </div>
        </div>
      ) : (
        <p className="px-4 py-3 text-xs text-slate-500">
          {status === "answered"
            ? `Response sent${block.answers?.flat().length ? `: ${block.answers.flat().join(", ")}` : "."}`
            : "Question skipped. The agent can continue or stop gracefully."}
        </p>
      )}
    </section>
  );
}
