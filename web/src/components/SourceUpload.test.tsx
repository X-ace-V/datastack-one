// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SourceUpload } from "./SourceUpload";

describe("SourceUpload composer menu", () => {
  afterEach(cleanup);

  it("selects multiple supported files through the composer attachment button", () => {
    const onFiles = vi.fn();
    render(<SourceUpload onFiles={onFiles} onConnectFolder={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "Add files or folder" }));
    expect(screen.getByRole("button", { name: "Upload files" })).toBeTruthy();
    const files = [
      new File(["a,b\n1,2"], "loans.csv", { type: "text/csv" }),
      new File(["select 1"], "model.sql", { type: "text/plain" }),
    ];
    fireEvent.change(screen.getByLabelText("Choose files to upload"), { target: { files } });
    expect(onFiles).toHaveBeenCalledWith(files);
  });

  it("starts a folder-rooted session from the same plus menu", () => {
    const onConnectFolder = vi.fn();
    render(<SourceUpload onFiles={() => {}} onConnectFolder={onConnectFolder} />);
    fireEvent.click(screen.getByRole("button", { name: "Add files or folder" }));
    fireEvent.click(screen.getByRole("button", { name: "Start session from folder" }));
    expect(onConnectFolder).toHaveBeenCalledOnce();
  });

  it("offers a new session when a workspace is already connected", () => {
    render(<SourceUpload hasFolder onFiles={() => {}} onConnectFolder={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Add files or folder" }));
    expect(screen.getByRole("button", { name: "Start session in another folder" })).toBeTruthy();
  });
});
