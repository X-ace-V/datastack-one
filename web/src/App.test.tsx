// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { App } from "./App";
import { WIZARD_STEPS } from "./wizard";

// The Create step fetches `/api/projects` on mount; stub it so these routing tests
// never touch the network and stay deterministic.
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ projects: [] }) })),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

describe("wizard app shell", () => {
  it("renders all six wizard steps, in order, as navigable links", () => {
    renderAt("/create");

    const nav = screen.getByRole("navigation", { name: /pipeline steps/i });
    const links = within(nav).getAllByRole("link");

    expect(links).toHaveLength(WIZARD_STEPS.length);
    WIZARD_STEPS.forEach((step, index) => {
      const link = links[index]!;
      expect(link.textContent).toContain(step.label);
      expect(link.getAttribute("href")).toBe(`/${step.slug}`);
    });
  });

  it("redirects '/' to the first step", () => {
    renderAt("/");
    expect(
      screen.getByRole("heading", { level: 1, name: "Create project" }),
    ).toBeTruthy();
  });

  it("renders each step's page at its route and marks its link current", () => {
    for (const step of WIZARD_STEPS) {
      renderAt(`/${step.slug}`);

      expect(
        screen.getByRole("heading", { level: 1, name: step.title }),
      ).toBeTruthy();
      expect(screen.getByText(step.summary)).toBeTruthy();

      // NavLink sets aria-current="page" on the active step only.
      const current = screen.getByRole("link", { current: "page" });
      expect(current.textContent).toContain(step.label);
      expect(current.getAttribute("href")).toBe(`/${step.slug}`);

      cleanup();
    }
  });

  it("shows a 404 page for an unknown route", () => {
    renderAt("/does-not-exist");
    expect(
      screen.getByRole("heading", { level: 1, name: /page not found/i }),
    ).toBeTruthy();
    // The wizard chrome still renders around the fallback.
    expect(
      screen.getByRole("navigation", { name: /pipeline steps/i }),
    ).toBeTruthy();
  });
});
