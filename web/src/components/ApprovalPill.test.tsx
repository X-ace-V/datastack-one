// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApprovalPill, type ApprovalBlock } from "./ApprovalPill";

/**
 * Component test for ApprovalPill (V2.6, FR10). Asserts the desired result, not merely that it
 * mounts: a pending pill shows the exact SQL and Allow/Deny buttons; Allow POSTs `approve` to
 * `POST /api/approvals/:requestID` and clears the buttons; Deny POSTs `reject`; a resolved block
 * renders its terminal status with no buttons; and a failed answer surfaces the error and keeps
 * the buttons so the human can retry. `fetch` is mocked against the real approvals REST contract.
 */

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

/** Install a fetch mock that returns `response` for every call, recording each request. */
function installFetch(response: Response): Call[] {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    return response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

const block = (over: Partial<ApprovalBlock> = {}): ApprovalBlock => ({
  kind: "approval",
  requestID: "req_1",
  approvalType: "run_transform",
  metadata: { sql: "CREATE TABLE marts.branch_report AS SELECT * FROM staging.loans" },
  callID: "call_1",
  status: "pending",
  ...over,
});

describe("ApprovalPill", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("shows the gated tool and the exact SQL for review, with Allow/Deny buttons", () => {
    installFetch(jsonResponse(200, {}));
    render(<ApprovalPill block={block()} />);

    expect(screen.getByText("run_transform")).toBeTruthy();
    expect(screen.getByTestId("approval-sql").textContent).toContain(
      "CREATE TABLE marts.branch_report",
    );
    expect(screen.getByRole("button", { name: "Allow" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Deny" })).toBeTruthy();
    expect(screen.getByTestId("approval-status").textContent).toBe("Needs approval");
  });

  it("Allow POSTs an approve decision and clears the buttons", async () => {
    const calls = installFetch(
      jsonResponse(200, {
        requestID: "req_1",
        action: "approve",
        type: "run_transform",
        status: "approved",
      }),
    );
    render(<ApprovalPill block={block()} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("/api/approvals/req_1");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toEqual({ action: "approve" });

    // Buttons clear optimistically the moment the answer succeeds (FR10 "clears on reply").
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Deny" })).toBeNull();
    });
    expect(screen.getByTestId("approval-status").textContent).toBe("Approved");
  });

  it("Deny POSTs a reject decision and clears the buttons", async () => {
    const calls = installFetch(
      jsonResponse(200, {
        requestID: "req_1",
        action: "reject",
        type: "run_transform",
        status: "rejected",
      }),
    );
    render(<ApprovalPill block={block()} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    });

    expect(calls[0]?.body).toEqual({ action: "reject" });
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Deny" })).toBeNull();
    });
    expect(screen.getByTestId("approval-status").textContent).toBe("Denied");
  });

  it("renders a store-resolved block as terminal with no buttons and no request", () => {
    const calls = installFetch(jsonResponse(200, {}));
    const { rerender } = render(<ApprovalPill block={block({ status: "approved" })} />);

    expect(screen.getByTestId("approval-status").textContent).toBe("Approved");
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Deny" })).toBeNull();

    rerender(<ApprovalPill block={block({ status: "rejected" })} />);
    expect(screen.getByTestId("approval-status").textContent).toBe("Denied");
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();

    // A resolved block never posts to the approvals API.
    expect(calls).toHaveLength(0);
  });

  it("surfaces an error and keeps the buttons when the answer fails", async () => {
    installFetch(jsonResponse(404, { error: "no pending approval for request \"req_1\"" }));
    render(<ApprovalPill block={block()} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    });

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("no pending approval");
    });
    // The buttons remain so the human can retry — the gate is not silently cleared.
    expect(screen.getByRole("button", { name: "Allow" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Deny" })).toBeTruthy();
    expect(screen.getByTestId("approval-status").textContent).toBe("Needs approval");
  });

  it("falls back to the command for a bash-style approval with no SQL key", () => {
    installFetch(jsonResponse(200, {}));
    render(
      <ApprovalPill
        block={block({
          approvalType: "bash",
          metadata: {},
          patterns: ["duckdb -c \"COPY marts.report TO 'out.parquet'\""],
        })}
      />,
    );
    expect(screen.getByTestId("approval-sql").textContent).toContain("COPY marts.report");
  });
});
