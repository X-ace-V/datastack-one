// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { InlineSteps } from "./InlineSteps";
import type { InlineBlock } from "../store/sessionStore";

/**
 * Component test for InlineSteps (V2.5, FR2, ARCHITECTURE §4). Asserts blocks render in reading
 * order — reasoning, then a tool card, then text — with each tool card carrying its status; that
 * reasoning is a collapsible section; and that an approval block (the V2.6 seam) renders nothing.
 */
describe("InlineSteps", () => {
  afterEach(cleanup);

  it("renders text, reasoning, and tool blocks in reading order with tool status", () => {
    const blocks: InlineBlock[] = [
      { kind: "reasoning", partID: "r1", text: "deciding which query to run" },
      {
        kind: "tool",
        callID: "c1",
        tool: "run_query",
        status: "completed",
        input: { sql: "SELECT 1" },
        output: "1 row",
      },
      { kind: "text", partID: "p1", text: "There is one row." },
    ];
    const { container } = render(<InlineSteps blocks={blocks} />);

    const children = Array.from(container.firstElementChild!.children);
    expect(children[0]?.getAttribute("data-role")).toBe("reasoning");
    expect(children[1]?.getAttribute("data-role")).toBe("tool");
    expect(children[1]?.getAttribute("data-tool")).toBe("run_query");
    expect(children[1]?.getAttribute("data-status")).toBe("completed");
    expect(children[2]?.tagName).toBe("P");
    expect(children[2]?.textContent).toBe("There is one row.");
  });

  it("collapses reasoning behind a Thinking toggle", () => {
    const blocks: InlineBlock[] = [
      { kind: "reasoning", partID: "r1", text: "the hidden chain of thought" },
    ];
    render(<InlineSteps blocks={blocks} />);

    // Collapsed by default — the text is not shown until expanded.
    expect(screen.queryByText("the hidden chain of thought")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /thinking/i }));
    expect(screen.getByText("the hidden chain of thought")).toBeTruthy();
  });

  it("renders nothing for an approval block (V2.6 seam) or an empty-text block", () => {
    const blocks: InlineBlock[] = [
      { kind: "text", partID: "p1", text: "" },
      {
        kind: "approval",
        requestID: "req-1",
        approvalType: "run_transform",
        metadata: { sql: "CREATE TABLE ..." },
        status: "pending",
      },
    ];
    const { container } = render(<InlineSteps blocks={blocks} />);
    expect(container.textContent).toBe("");
  });
});
