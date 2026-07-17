// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { App } from "./App";

/**
 * V0.2 — the three-pane agent shell. Asserts the layout renders its three landmark regions
 * (session sidebar · chat · data panel) as accessibly-named landmarks, so the shell is the
 * conversational frame the PRD v2 describes rather than the removed wizard. The regions are
 * empty placeholders at this task; later tasks fill them (sidebar V2.3, chat V2.4, panel V3.4).
 */
describe("App shell", () => {
  afterEach(cleanup);

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
