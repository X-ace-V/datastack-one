// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Composer } from "./Composer";

/**
 * Component test for the Composer (V2.4, FR2). Asserts the send/cancel behaviour that matters: a
 * whitespace-only message never sends, Send fires the trimmed text and clears the box, Enter sends
 * while Shift+Enter is a newline, and while a turn is in flight Send becomes Cancel.
 */
describe("Composer", () => {
  afterEach(cleanup);

  it("disables send until there is non-whitespace text", () => {
    render(<Composer isWorking={false} onSend={() => {}} onCancel={() => {}} />);
    const send = screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);

    const box = screen.getByLabelText("Message the agent");
    fireEvent.change(box, { target: { value: "   " } });
    expect(send.disabled).toBe(true);

    fireEvent.change(box, { target: { value: "profile it" } });
    expect(send.disabled).toBe(false);
  });

  it("sends the trimmed text and clears the box on click", () => {
    const onSend = vi.fn();
    render(<Composer isWorking={false} onSend={onSend} onCancel={() => {}} />);
    const box = screen.getByLabelText("Message the agent") as HTMLTextAreaElement;

    fireEvent.change(box, { target: { value: "  clean the data  " } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith("clean the data");
    expect(box.value).toBe("");
  });

  it("sends on Enter but inserts a newline on Shift+Enter", () => {
    const onSend = vi.fn();
    render(<Composer isWorking={false} onSend={onSend} onCancel={() => {}} />);
    const box = screen.getByLabelText("Message the agent");

    fireEvent.change(box, { target: { value: "which branch is overdue" } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("which branch is overdue");
  });

  it("does not send a whitespace-only message on Enter", () => {
    const onSend = vi.fn();
    render(<Composer isWorking={false} onSend={onSend} onCancel={() => {}} />);
    const box = screen.getByLabelText("Message the agent");

    fireEvent.change(box, { target: { value: "   " } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("swaps Send for Cancel while a turn is in flight and cancels on click", () => {
    const onCancel = vi.fn();
    render(<Composer isWorking={true} onSend={() => {}} onCancel={onCancel} />);

    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
