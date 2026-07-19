// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FolderPicker } from "./FolderPicker";

describe("FolderPicker", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("browses server-approved folders and starts in the selected directory", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("path=")) {
        return {
          ok: true,
          json: async () => ({
            path: "/allowed/pipeline",
            parent: "/allowed",
            folders: [{ name: "models", path: "/allowed/pipeline/models" }],
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          path: null,
          parent: null,
          folders: [{ name: "pipeline", path: "/allowed/pipeline" }],
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);
    const connect = vi.fn(async () => {});
    const close = vi.fn();
    render(<FolderPicker onConnect={connect} onClose={close} />);

    fireEvent.click(await screen.findByRole("button", { name: /pipeline/i }));
    await screen.findByText("/allowed/pipeline");
    fireEvent.click(screen.getByRole("button", { name: "Start session here" }));

    await waitFor(() => expect(connect).toHaveBeenCalledWith("/allowed/pipeline"));
    expect(close).toHaveBeenCalledOnce();
  });

  it("can close without connecting", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ path: null, parent: null, folders: [] }),
    })));
    const close = vi.fn();
    render(<FolderPicker onConnect={async () => {}} onClose={close} />);
    fireEvent.click(screen.getByRole("button", { name: "Close folder picker" }));
    expect(close).toHaveBeenCalledOnce();
  });
});
