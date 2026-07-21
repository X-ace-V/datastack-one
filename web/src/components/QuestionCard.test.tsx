// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QuestionCard, type QuestionBlock } from "./QuestionCard";

const block: QuestionBlock = {
  kind: "question",
  requestID: "question_1",
  status: "pending",
  questions: [
    {
      header: "Warehouse",
      question: "Which warehouse should I target?",
      options: [
        { label: "DuckDB", description: "Run locally" },
        { label: "Snowflake", description: "Use the cloud" },
      ],
      custom: false,
    },
    {
      header: "Checks",
      question: "Which checks should I add?",
      options: [
        { label: "Freshness", description: "Check recency" },
        { label: "Uniqueness", description: "Check keys" },
      ],
      multiple: true,
    },
  ],
};

function response(ok = true) {
  return {
    ok,
    status: ok ? 200 : 502,
    json: async () => ok
      ? ({ requestID: "question_1", status: "answered" })
      : ({ error: "runtime unavailable" }),
    text: async () => "runtime unavailable",
  };
}

describe("QuestionCard", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("submits ordered single, multiple, and custom answers", async () => {
    const fetchMock = vi.fn(async (_input: string, _init?: RequestInit) => response());
    vi.stubGlobal("fetch", fetchMock);
    render(<QuestionCard block={block} />);

    const continueButton = screen.getByRole("button", { name: "Continue" });
    expect((continueButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: /DuckDB.*Run locally/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Freshness.*Check recency/i }));
    fireEvent.change(screen.getByPlaceholderText("Type your own answer"), {
      target: { value: "Accepted values" },
    });
    expect((continueButton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(continueButton);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/questions/question_1");
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({
      action: "answer",
      answers: [["DuckDB"], ["Freshness", "Accepted values"]],
    });
    await waitFor(() => expect(screen.getByText("Answered")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
  });

  it("supports a default-enabled custom answer on a single-choice question", async () => {
    const fetchMock = vi.fn(async (_input: string, _init?: RequestInit) => response());
    vi.stubGlobal("fetch", fetchMock);
    render(<QuestionCard block={{
      ...block,
      questions: [{
        header: "Format",
        question: "Which format?",
        options: [{ label: "Parquet", description: "Columnar" }],
      }],
    }} />);
    fireEvent.change(screen.getByPlaceholderText("Type your own answer"), {
      target: { value: "Delta Lake" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string).answers)
      .toEqual([["Delta Lake"]]);
  });

  it("can reject the question so the agent is not left waiting", async () => {
    const fetchMock = vi.fn(async (_input: string, _init?: RequestInit) => response());
    vi.stubGlobal("fetch", fetchMock);
    render(<QuestionCard block={block} />);
    fireEvent.click(screen.getByRole("button", { name: "Skip question" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({ action: "reject" });
    await waitFor(() => expect(screen.getByText("Skipped")).toBeTruthy());
  });

  it("keeps controls available when the reply fails so the user can retry", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(false)));
    render(<QuestionCard block={block} />);
    fireEvent.click(screen.getByRole("button", { name: "Skip question" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("runtime unavailable"));
    expect(screen.getByRole("button", { name: "Skip question" })).toBeTruthy();
  });
});
