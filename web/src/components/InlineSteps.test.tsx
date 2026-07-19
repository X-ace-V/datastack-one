// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { InlineSteps } from "./InlineSteps";
import type { InlineBlock } from "../store/sessionStore";

/**
 * Component test for InlineSteps (V2.5/V2.6, FR2/FR10, ARCHITECTURE §4). Asserts blocks render in
 * reading order — reasoning, then a tool card, then text — with each tool card carrying its status;
 * that reasoning is a collapsible section; that an empty-text block renders nothing; and that an
 * approval block renders an inline approval pill (V2.6).
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
    expect(children[2]?.classList.contains("markdown-content")).toBe(true);
    expect(children[2]?.querySelector("p")).toBeTruthy();
    expect(children[2]?.textContent).toBe("There is one row.");
  });

  it("renders agent text as GitHub-flavoured Markdown", () => {
    const blocks: InlineBlock[] = [
      {
        kind: "text",
        partID: "p1",
        text: "## Result\n\n- **north**\n- `south`\n\n| branch | rows |\n| --- | ---: |\n| north | 4 |",
      },
    ];
    const { container } = render(<InlineSteps blocks={blocks} />);

    expect(screen.getByRole("heading", { name: "Result", level: 2 })).toBeTruthy();
    expect(container.querySelector("strong")?.textContent).toBe("north");
    expect(container.querySelector("code")?.textContent).toBe("south");
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByRole("table")).toBeTruthy();
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

  it("renders an inline approval pill for an approval block, skipping empty text (V2.6)", () => {
    const blocks: InlineBlock[] = [
      { kind: "text", partID: "p1", text: "" },
      {
        kind: "approval",
        requestID: "req-1",
        approvalType: "run_transform",
        metadata: { sql: "CREATE TABLE marts.report AS SELECT 1" },
        status: "pending",
      },
    ];
    const { container } = render(<InlineSteps blocks={blocks} />);

    // The empty-text block renders nothing; the approval renders a pill in its place.
    const children = Array.from(container.firstElementChild!.children);
    expect(children).toHaveLength(1);
    const pill = children[0];
    expect(pill?.getAttribute("data-role")).toBe("approval");
    expect(pill?.getAttribute("data-approval-type")).toBe("run_transform");
    expect(screen.getByTestId("approval-sql").textContent).toContain("CREATE TABLE marts.report");
    expect(screen.getByRole("button", { name: "Allow" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Deny" })).toBeTruthy();
  });
});
