// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MessageBubble } from "./MessageBubble";
import type { AssistantMessage, UserMessage } from "../store/sessionStore";

/**
 * Component test for MessageBubble (V2.4, FR2). Asserts the desired render, not merely that it
 * mounts: a user turn shows its content in a right-aligned bubble, an assistant turn renders its
 * streamed text parts in order, and a text-less assistant turn (only a tool call so far) renders
 * nothing rather than an empty bubble.
 */
describe("MessageBubble", () => {
  afterEach(cleanup);

  it("renders a user turn's content in a right-aligned bubble", () => {
    const message: UserMessage = { role: "user", id: "u1", content: "profile the loans" };
    const { container } = render(<MessageBubble message={message} />);

    expect(screen.getByText("profile the loans")).toBeTruthy();
    const wrapper = container.querySelector('[data-role="user"]');
    expect(wrapper).toBeTruthy();
    expect(wrapper?.className).toContain("justify-end");
  });

  it("renders an assistant turn's streamed text parts in reading order", () => {
    const message: AssistantMessage = {
      role: "assistant",
      id: "a1",
      blocks: [
        { kind: "text", partID: "p1", text: "The loans table has " },
        { kind: "text", partID: "p2", text: "4 branches." },
      ],
    };
    const { container } = render(<MessageBubble message={message} />);

    const wrapper = container.querySelector('[data-role="assistant"]');
    expect(wrapper).toBeTruthy();
    expect(wrapper?.className).toContain("justify-start");
    const paragraphs = wrapper!.querySelectorAll("p");
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0]?.textContent).toBe("The loans table has ");
    expect(paragraphs[1]?.textContent).toBe("4 branches.");
  });

  it("renders nothing for a text-less assistant turn (tool-only, until V2.5)", () => {
    const message: AssistantMessage = {
      role: "assistant",
      id: "a2",
      blocks: [
        { kind: "tool", callID: "c1", tool: "run_query", status: "running" },
        { kind: "reasoning", partID: "r1", text: "planning the query" },
      ],
    };
    const { container } = render(<MessageBubble message={message} />);

    expect(container.querySelector('[data-role="assistant"]')).toBeNull();
    expect(container.textContent).toBe("");
  });
});
