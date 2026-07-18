// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { SessionModelControl } from "./SessionModelControl";
import type { ModelCatalog } from "../lib/api";

/**
 * Component test for the per-session model control (V6.1, FR11). It wires the ModelPicker to the
 * active session's stored model against the real REST contract (`GET /api/sessions/:id`,
 * `GET /api/models`, `PATCH /api/sessions/:id`) with a mocked fetch: it preselects the session's
 * model, persists a change as a PATCH, and reverts + reports a failed save.
 */

const CATALOG: ModelCatalog = {
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

interface Call {
  url: string;
  method: string;
  body: { model?: string | null } | undefined;
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

/**
 * Install a fetch that answers the three endpoints the control drives. `sessionModel` is what the
 * session read returns; `patchStatus` lets a test force a failed save.
 */
function installFetch(opts: {
  sessionModel: string | null;
  patchStatus?: number;
}): Call[] {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    const call: Call = { url: String(url), method, body };
    calls.push(call);

    if (call.url === "/api/models") {
      return jsonResponse(200, CATALOG);
    }
    if (method === "PATCH") {
      const status = opts.patchStatus ?? 200;
      if (status >= 300) return jsonResponse(status, { error: "save failed" });
      // The route echoes the persisted row — reflect the model the patch set.
      return jsonResponse(200, {
        id: "ses_1",
        title: "Session",
        model: body?.model ?? null,
        createdAt: "2026-07-17T00:00:00Z",
        updatedAt: "2026-07-17T00:00:01Z",
      });
    }
    // GET /api/sessions/:id — the session with its (empty) history.
    return jsonResponse(200, {
      id: "ses_1",
      title: "Session",
      model: opts.sessionModel,
      createdAt: "2026-07-17T00:00:00Z",
      updatedAt: "2026-07-17T00:00:00Z",
      messages: [],
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

describe("SessionModelControl", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("preselects the session's stored model", async () => {
    installFetch({ sessionModel: "anthropic/claude-opus-4-5" });
    render(<SessionModelControl sessionId="ses_1" />);

    const select = (await screen.findByLabelText(/^model$/i)) as HTMLSelectElement;
    // The picker follows the session's model, not the catalog default.
    await waitFor(() => expect(select.value).toBe("anthropic/claude-opus-4-5"));
  });

  it("persists a model change with PATCH and reflects the saved value", async () => {
    const calls = installFetch({ sessionModel: null });
    render(<SessionModelControl sessionId="ses_1" />);

    const select = (await screen.findByLabelText(/^model$/i)) as HTMLSelectElement;
    // A null-model session follows the platform default until the user chooses.
    await waitFor(() => expect(select.value).toBe("opencode/big-pickle"));

    await act(async () => {
      fireEvent.change(select, { target: { value: "opencode/hy3-free" } });
    });

    // The change was persisted as a PATCH carrying exactly the chosen ref.
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.method === "PATCH" &&
            c.url === "/api/sessions/ses_1" &&
            c.body?.model === "opencode/hy3-free",
        ),
      ).toBe(true),
    );
    expect(select.value).toBe("opencode/hy3-free");
  });

  it("reverts the selection and reports an error when the save fails", async () => {
    installFetch({ sessionModel: null, patchStatus: 500 });
    render(<SessionModelControl sessionId="ses_1" />);

    const select = (await screen.findByLabelText(/^model$/i)) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("opencode/big-pickle"));

    await act(async () => {
      fireEvent.change(select, { target: { value: "opencode/hy3-free" } });
    });

    // A failed save surfaces an error and rolls the selection back to what actually persists.
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("save failed");
    await waitFor(() => expect(select.value).toBe("opencode/big-pickle"));
  });
});
