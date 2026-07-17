// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ModelPicker } from "./ModelPicker";
import type { ModelCatalog } from "../lib/api";

/**
 * Component test for the ModelPicker (T6.3, FR11). `fetch` is mocked against the real
 * `GET /api/models` contract, using catalogs shaped like the ones a live runtime returns: free
 * `opencode` models always, plus `anthropic` only when a provider key is in the environment.
 */

const FREE_ONLY: ModelCatalog = {
  default: "opencode/big-pickle",
  providers: [
    {
      id: "opencode",
      name: "OpenCode Zen",
      source: "custom",
      models: [
        {
          ref: "opencode/big-pickle",
          providerID: "opencode",
          modelID: "big-pickle",
          name: "Big Pickle",
          toolcall: true,
          reasoning: true,
          cost: { input: 0, output: 0 },
          free: true,
        },
        {
          ref: "opencode/hy3-free",
          providerID: "opencode",
          modelID: "hy3-free",
          name: "HY3",
          toolcall: true,
          reasoning: true,
          cost: { input: 0, output: 0 },
          free: true,
        },
      ],
    },
  ],
};

const WITH_PAID: ModelCatalog = {
  default: "opencode/big-pickle",
  providers: [
    {
      id: "anthropic",
      name: "Anthropic",
      source: "env",
      models: [
        {
          ref: "anthropic/claude-opus-4-5",
          providerID: "anthropic",
          modelID: "claude-opus-4-5",
          name: "Claude Opus 4.5",
          toolcall: true,
          reasoning: true,
          cost: { input: 5, output: 25 },
          free: false,
        },
      ],
    },
    ...FREE_ONLY.providers,
  ],
};

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function installFetch(response: () => Response) {
  const fetchMock = vi.fn(async () => response());
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("ModelPicker", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("loads the catalog from /api/models and preselects the platform default", async () => {
    const fetchMock = installFetch(() => jsonResponse(200, FREE_ONLY));
    render(<ModelPicker value={null} onChange={() => {}} />);

    const select = (await screen.findByLabelText(/^model$/i)) as HTMLSelectElement;
    // A null selection follows the platform default rather than the first catalog entry.
    await waitFor(() => expect(select.value).toBe("opencode/big-pickle"));
    expect(fetchMock).toHaveBeenCalledWith("/api/models");
  });

  it("lists a tier's models grouped by provider with their price", async () => {
    installFetch(() => jsonResponse(200, WITH_PAID));
    render(<ModelPicker value={null} onChange={() => {}} />);

    await screen.findByLabelText(/^model$/i);
    // The free tier is active, so only free models are offered.
    await waitFor(() =>
      expect(screen.getByRole("option", { name: /Big Pickle — free/ })).toBeTruthy(),
    );
    expect(screen.getByRole("option", { name: /HY3 — free/ })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /Claude Opus/ })).toBeNull();
  });

  it("switches to a paid model when the quality tier is toggled", async () => {
    const onChange = vi.fn();
    installFetch(() => jsonResponse(200, WITH_PAID));
    render(<ModelPicker value={null} onChange={onChange} />);

    const quality = await screen.findByRole("button", { name: /quality \(paid\)/i });
    await waitFor(() => expect((quality as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(quality);

    // One click moves the flow onto a paid model (PRD §7's escape hatch from a weak free model).
    expect(onChange).toHaveBeenCalledWith("anthropic/claude-opus-4-5");
  });

  it("shows the selected paid model, its price and the quality tier as active", async () => {
    installFetch(() => jsonResponse(200, WITH_PAID));
    render(<ModelPicker value="anthropic/claude-opus-4-5" onChange={() => {}} />);

    const select = (await screen.findByLabelText(/^model$/i)) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("anthropic/claude-opus-4-5"));
    expect(
      screen.getByRole("button", { name: /quality \(paid\)/i }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.getByRole("button", { name: /^free$/i }).getAttribute("aria-pressed")).toBe(
      "false",
    );
    // Price is shown per 1M tokens (the unit the runtime reports) on both the option and the
    // summary line beneath the select, so the cost of the choice is visible either way.
    expect(
      screen.getByRole("option", { name: "Claude Opus 4.5 — $5/$25 per 1M tokens" }),
    ).toBeTruthy();
    expect(
      screen.getByText(/\$5\/\$25 per 1M tokens/, { selector: "p" }).textContent,
    ).toContain("anthropic/claude-opus-4-5");
  });

  it("disables the quality tier and names the key to set when no paid provider is configured", async () => {
    const onChange = vi.fn();
    installFetch(() => jsonResponse(200, FREE_ONLY));
    render(<ModelPicker value={null} onChange={onChange} />);

    const quality = await screen.findByRole("button", { name: /quality \(paid\)/i });
    await waitFor(() => expect((quality as HTMLButtonElement).disabled).toBe(true));
    // An empty tier is reported honestly instead of silently selecting a free model.
    fireEvent.click(quality);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText(/ANTHROPIC_API_KEY/)).toBeTruthy();
  });

  it("keeps a selection the runtime no longer offers visible and warns about it", async () => {
    installFetch(() => jsonResponse(200, FREE_ONLY));
    // A model stored while a provider key was set, now that the key is gone.
    render(<ModelPicker value="anthropic/claude-opus-4-5" onChange={() => {}} />);

    const select = (await screen.findByLabelText(/^model$/i)) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("anthropic/claude-opus-4-5"));
    expect(screen.getByRole("option", { name: /unavailable/i })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("not offered by the runtime");
  });

  it("reports an unreadable catalog instead of showing an empty picker", async () => {
    installFetch(() => jsonResponse(503, { error: "model runtime unavailable" }));
    render(<ModelPicker value={null} onChange={() => {}} />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("model runtime unavailable");
    // No selection is offered, and the copy says what will actually happen.
    expect(screen.queryByLabelText(/^model$/i)).toBeNull();
    expect(screen.getByText(/default free model/i)).toBeTruthy();
  });

  it("disables the control while a generation stage is in flight", async () => {
    installFetch(() => jsonResponse(200, WITH_PAID));
    render(<ModelPicker value={null} onChange={() => {}} disabled />);

    const select = (await screen.findByLabelText(/^model$/i)) as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(true));
    expect(
      (screen.getByRole("button", { name: /quality \(paid\)/i }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
