// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ChatStream } from "./ChatStream";
import type { ChatMessage } from "../store/sessionStore";

/**
 * Component test for ChatStream (V2.4, FR2). Asserts the transcript renders both roles in order,
 * shows the empty prompt only when there is truly nothing, surfaces the working indicator while a
 * turn streams, and raises the turn error as an alert.
 */
describe("ChatStream", () => {
  afterEach(cleanup);

  const CONVO: ChatMessage[] = [
    { role: "user", id: "u1", content: "how many branches?" },
    {
      role: "assistant",
      id: "a1",
      blocks: [{ kind: "text", partID: "p1", text: "There are 4 branches." }],
    },
  ];

  it("renders the empty prompt when there are no messages and nothing is in flight", () => {
    render(<ChatStream messages={[]} isWorking={false} error={null} />);
    expect(screen.getByText(/connect a project folder or upload a dataset/i)).toBeTruthy();
  });

  it("renders user and assistant turns in order", () => {
    render(<ChatStream messages={CONVO} isWorking={false} error={null} />);
    expect(screen.getByText("how many branches?")).toBeTruthy();
    expect(screen.getByText("There are 4 branches.")).toBeTruthy();
    expect(screen.queryByText(/ask the agent to profile/i)).toBeNull();
  });

  it("shows the working indicator while a turn is streaming", () => {
    render(<ChatStream messages={CONVO} isWorking={true} error={null} />);
    expect(screen.getByRole("status", { name: "Agent working" })).toBeTruthy();
    expect(screen.getByText("Working…")).toBeTruthy();
  });

  it("says it is waiting for an answer when a question is pending", () => {
    const messages: ChatMessage[] = [{
      role: "assistant",
      id: "a-question",
      blocks: [{
        kind: "question",
        requestID: "q1",
        status: "pending",
        questions: [{
          header: "Warehouse",
          question: "Which warehouse?",
          options: [{ label: "DuckDB", description: "Local" }],
        }],
      }],
    }];
    render(<ChatStream messages={messages} isWorking={true} error={null} />);
    expect(screen.getByRole("status", { name: "Agent waiting for input" })).toBeTruthy();
    expect(screen.getByText("Waiting for your answer…")).toBeTruthy();
  });

  it("surfaces a turn error as an alert", () => {
    render(<ChatStream messages={CONVO} isWorking={false} error="model overloaded" />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("model overloaded");
  });
});
