// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { App } from "./App";

/**
 * V0.2 — the three-pane agent shell. Asserts the layout renders its three landmark regions
 * (session sidebar · chat · data panel) as accessibly-named landmarks, so the shell is the
 * conversational frame the PRD v2 describes rather than the removed wizard. The chat and data
 * panel are placeholders at this task; the sidebar (V2.3) is now the real component, so `fetch`
 * is stubbed to the empty `GET /api/sessions` contract to keep these landmark assertions
 * deterministic (the sidebar's own behaviour is covered by Sidebar.test.tsx).
 */
describe("App shell", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ sessions: [] }),
      })),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders the session sidebar as a named navigation landmark", () => {
    render(<App />);
    const sidebar = screen.getByRole("navigation", { name: "Sessions" });
    expect(sidebar).toBeTruthy();
  });

  it("renders the chat region as a named main landmark", () => {
    render(<App />);
    const chat = screen.getByRole("main", { name: "Chat" });
    expect(chat).toBeTruthy();
  });

  it("renders the data panel as a named complementary landmark", () => {
    render(<App />);
    const panel = screen.getByRole("complementary", { name: "Data panel" });
    expect(panel).toBeTruthy();
  });

  it("renders all three regions as siblings of one shell container", () => {
    const { container } = render(<App />);
    const shell = container.firstElementChild;
    expect(shell).toBeTruthy();
    const nav = shell?.querySelector('nav[aria-label="Sessions"]');
    const main = shell?.querySelector('main[aria-label="Chat"]');
    const aside = shell?.querySelector('aside[aria-label="Data panel"]');
    expect(nav).toBeTruthy();
    expect(main).toBeTruthy();
    expect(aside).toBeTruthy();
    // The three panes are direct children of the same grid container, in reading order.
    expect(nav?.parentElement).toBe(shell);
    expect(main?.parentElement).toBe(shell);
    expect(aside?.parentElement).toBe(shell);
  });
});
