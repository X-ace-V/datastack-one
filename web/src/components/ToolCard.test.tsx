// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ToolCard, type ToolBlock } from "./ToolCard";

/**
 * Component test for ToolCard (V2.5, FR2). Asserts the desired render, not merely that it mounts:
 * the collapsed header shows the tool name + a status badge; expanding reveals the exact
 * arguments and the result; each status maps to its human label; and a bare call with nothing to
 * show is not expandable.
 */
describe("ToolCard", () => {
  afterEach(cleanup);

  const block = (over: Partial<ToolBlock> = {}): ToolBlock => ({
    kind: "tool",
    callID: "c1",
    tool: "run_query",
    status: "running",
    ...over,
  });

  it("renders the tool name and a status badge in the collapsed header", () => {
    const { container } = render(<ToolCard block={block({ status: "running" })} />);

    const card = container.querySelector('[data-role="tool"]');
    expect(card?.getAttribute("data-tool")).toBe("run_query");
    expect(card?.getAttribute("data-status")).toBe("running");
    expect(screen.getByText("run_query")).toBeTruthy();
    expect(screen.getByTestId("tool-status").textContent).toBe("Running");
    // Collapsed: args/result are not in the DOM yet.
    expect(screen.queryByTestId("tool-args")).toBeNull();
  });

  it("expands to show the exact arguments and the result", () => {
    render(
      <ToolCard
        block={block({
          status: "completed",
          input: { sql: "SELECT * FROM raw.source" },
          output: "42 rows",
        })}
      />,
    );

    expect(screen.getByTestId("tool-status").textContent).toBe("Done");
    expect(screen.queryByTestId("tool-args")).toBeNull();

    fireEvent.click(screen.getByRole("button"));

    expect(screen.getByTestId("tool-args").textContent).toContain("SELECT * FROM raw.source");
    expect(screen.getByTestId("tool-result").textContent).toBe("42 rows");
  });

  it("shows the error detail for a failed tool call", () => {
    render(
      <ToolCard block={block({ status: "error", error: "Binder Error: no such column" })} />,
    );

    expect(screen.getByTestId("tool-status").textContent).toBe("Error");
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByTestId("tool-error").textContent).toContain("no such column");
  });

  it.each([
    ["pending", "Pending"],
    ["running", "Running"],
    ["completed", "Done"],
    ["error", "Error"],
  ] as const)("labels the %s status as %s", (status, label) => {
    render(<ToolCard block={block({ status })} />);
    expect(screen.getByTestId("tool-status").textContent).toBe(label);
  });

  it("is not expandable when there are no args, output, or error", () => {
    render(<ToolCard block={block({ status: "pending" })} />);
    const button = screen.getByRole("button");
    expect((button as HTMLButtonElement).disabled).toBe(true);
    // Clicking a non-expandable card reveals nothing.
    fireEvent.click(button);
    expect(screen.queryByTestId("tool-args")).toBeNull();
    expect(screen.queryByTestId("tool-result")).toBeNull();
  });
});
