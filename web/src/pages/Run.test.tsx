// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { RunPage } from "./Run";
import type {
  Project,
  Run,
  RunApprovalRequest,
  RunEvent,
  RunStep,
} from "../lib/api";

/**
 * End-to-end component test for the Run page (T4.5, FR8/FR9). `fetch` and `EventSource` are both
 * mocked so the test drives a real run through its lifecycle against the actual API + SSE contract:
 * start the run, receive each gated stage's approval request over SSE, approve it (asserting the
 * exact SQL is shown for the transform), watch each step turn success, and land on the
 * Continue-to-Serve link once the run reports success. This is the "auto-approve in tests" path —
 * the test acts as the human answering every FR8 gate.
 */

function makeProject(over: Partial<Project> = {}): Project {
  return {
    id: "p-1",
    name: "Loan Book",
    domain: "lending",
    expectedVolume: null,
    warehouse: "duckdb",
    servingStyle: null,
    createdAt: "2026-07-17 00:00:00",
    ...over,
  };
}

const RUN: Run = {
  id: "run-1",
  projectId: "p-1",
  status: "pending",
  model: null,
  createdAt: "2026-07-17 00:00:00",
  updatedAt: "2026-07-17 00:00:00",
};

function makeStep(name: string, ordinal: number): RunStep {
  return {
    id: `s-${name}`,
    runId: "run-1",
    name,
    ordinal,
    status: "pending",
    detail: null,
    startedAt: null,
    finishedAt: null,
  };
}

const STEPS: RunStep[] = [
  makeStep("extract", 0),
  makeStep("land", 1),
  makeStep("load", 2),
  makeStep("transform", 3),
];

const TRANSFORM_SQL =
  "CREATE OR REPLACE TABLE marts.branch_totals AS SELECT branch, sum(balance) AS total FROM raw.source GROUP BY branch";

function approval(over: Partial<RunApprovalRequest> & { stepName: string }): RunApprovalRequest {
  return {
    requestID: `req-${over.stepName}`,
    runId: "run-1",
    stepId: `s-${over.stepName}`,
    tool: "tool",
    summary: `Run ${over.stepName}`,
    sql: null,
    args: {},
    ...over,
  };
}

/** A minimal `EventSource` stand-in: jsdom has none, so tests drive frames through `emit`. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  closed = false;
  private listeners = new Map<string, Array<(e: MessageEvent) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, cb: (e: MessageEvent) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(cb);
    this.listeners.set(type, list);
  }

  close(): void {
    this.closed = true;
  }

  emit(event: RunEvent): void {
    const frame = { data: JSON.stringify(event) } as MessageEvent;
    for (const cb of this.listeners.get(event.kind) ?? []) cb(frame);
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

interface FetchOpts {
  projects?: Project[];
  runResponse?: () => Response;
  /** The project's run history served by `GET /api/projects/:id/runs` (FR12). */
  runs?: Run[];
}

function installFetch(opts: FetchOpts = {}) {
  const approvalCalls: Array<{ url: string; action: string }> = [];
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/approvals/")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { action: string };
      approvalCalls.push({ url, action: body.action });
      return jsonResponse(200, { requestID: "x", action: body.action, status: "approved" });
    }
    if (url.endsWith("/run")) {
      return (opts.runResponse ?? (() => jsonResponse(202, { run: RUN, steps: STEPS })))();
    }
    // The project's run history (`/api/projects/:id/runs`) — checked before the run-state route
    // below, whose `/api/runs/` prefix this URL does not carry.
    if (url.endsWith("/runs")) {
      return jsonResponse(200, { runs: opts.runs ?? [] });
    }
    if (url.includes("/api/runs/")) {
      return jsonResponse(200, { run: RUN, steps: STEPS, approvals: [] });
    }
    return jsonResponse(200, { projects: opts.projects ?? [makeProject()] });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, approvalCalls };
}

function renderPage() {
  return render(
    <MemoryRouter>
      <RunPage />
    </MemoryRouter>,
  );
}

/** The single live `EventSource` the page opened for the run. */
function activeSource(): FakeEventSource {
  const source = FakeEventSource.instances.at(-1);
  if (!source) throw new Error("no EventSource was opened");
  return source;
}

async function emit(event: RunEvent): Promise<void> {
  await act(async () => {
    activeSource().emit(event);
  });
}

describe("run page", () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("prompts to create a project when none exist", async () => {
    installFetch({ projects: [] });
    renderPage();
    expect(await screen.findByText(/create a project first/i)).toBeTruthy();
  });

  it("drives a run to success, approving each gated stage with the exact SQL shown", async () => {
    const { approvalCalls } = installFetch();
    renderPage();

    // Start the run.
    const start = (await screen.findByRole("button", { name: /start run/i })) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(start);
    });

    // The stepper renders every stage from the backend.
    const progress = await screen.findByRole("region", { name: /run progress/i });
    for (const label of ["Extract", "Land Parquet", "Load Warehouse", "Transform"]) {
      expect(progress.textContent).toContain(label);
    }

    // The page subscribed to the run's SSE stream.
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));
    expect(activeSource().url).toBe("/api/runs/run-1/events");

    await emit({ kind: "run.status", runId: "run-1", status: "running" });

    // Extract (ungated) runs to success.
    await emit({
      kind: "step.status",
      runId: "run-1",
      stepId: "s-extract",
      name: "extract",
      status: "success",
      detail: "read 4 rows from loans.csv",
    });

    // Walk the three gated stages, approving each; land/load carry no SQL, transform carries it.
    const gates: Array<{ name: string; tool: string; sql: string | null }> = [
      { name: "land", tool: "land_parquet", sql: null },
      { name: "load", tool: "load_warehouse", sql: null },
      { name: "transform", tool: "run_transform", sql: TRANSFORM_SQL },
    ];

    for (const gate of gates) {
      await emit({
        kind: "approval.requested",
        runId: "run-1",
        request: approval({ stepName: gate.name, tool: gate.tool, sql: gate.sql }),
      });

      const dialog = await screen.findByRole("dialog", { name: /approval required/i });
      expect(dialog.textContent).toContain(gate.tool);
      if (gate.sql) {
        // The transform gate must show the exact SQL a human approves (FR8).
        expect(dialog.textContent).toContain(TRANSFORM_SQL);
      }

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /^approve$/i }));
      });

      // Backend acknowledged, then the runner streams the resolution + the stage's success.
      await emit({
        kind: "approval.resolved",
        runId: "run-1",
        requestID: `req-${gate.name}`,
        action: "approve",
      });
      await emit({
        kind: "step.status",
        runId: "run-1",
        stepId: `s-${gate.name}`,
        name: gate.name,
        status: "success",
        detail: `${gate.name} ok`,
      });

      // The modal closes once the gate is answered.
      await waitFor(() =>
        expect(screen.queryByRole("dialog", { name: /approval required/i })).toBeNull(),
      );
    }

    await emit({ kind: "run.status", runId: "run-1", status: "success" });

    // Every gate was approved (three write steps), and the run offers the served output.
    expect(approvalCalls.map((c) => c.action)).toEqual(["approve", "approve", "approve"]);
    expect(approvalCalls[2]?.url).toContain("/api/runs/run-1/approvals/req-transform");
    expect(screen.getByRole("link", { name: /continue to serve/i })).toBeTruthy();
    // Every stage reads success in the stepper.
    const successBadges = screen.getAllByText(/^Success$/);
    expect(successBadges.length).toBe(4);
  });

  it("aborts the run when a gate is rejected", async () => {
    const { approvalCalls } = installFetch();
    renderPage();

    const start = await screen.findByRole("button", { name: /start run/i });
    await act(async () => {
      fireEvent.click(start);
    });
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));

    await emit({ kind: "run.status", runId: "run-1", status: "running" });
    await emit({
      kind: "approval.requested",
      runId: "run-1",
      request: approval({ stepName: "land", tool: "land_parquet", sql: null }),
    });

    await screen.findByRole("dialog", { name: /approval required/i });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^reject$/i }));
    });

    await emit({
      kind: "approval.resolved",
      runId: "run-1",
      requestID: "req-land",
      action: "reject",
    });
    await emit({
      kind: "step.status",
      runId: "run-1",
      stepId: "s-land",
      name: "land",
      status: "failed",
      detail: "rejected by human at the approval gate",
    });
    await emit({ kind: "run.status", runId: "run-1", status: "rejected" });

    expect(approvalCalls).toEqual([
      { url: "/api/runs/run-1/approvals/req-land", action: "reject" },
    ]);
    expect(screen.getByText(/run aborted/i)).toBeTruthy();
    expect(screen.queryByRole("link", { name: /continue to serve/i })).toBeNull();
  });

  it("links a started run to its lineage and lists the project's run history", async () => {
    const earlier: Run = {
      ...RUN,
      id: "run-0",
      status: "failed",
      createdAt: "2026-07-16 09:00:00",
    };
    installFetch({ runs: [earlier] });
    renderPage();

    // The history lists past runs before any new run is started, each linking to its lineage (FR12).
    const history = await screen.findByRole("region", { name: /run history/i });
    await waitFor(() => expect(history.textContent).toContain("failed"));
    const historyLink = screen.getByRole("link", { name: "run-0" }) as HTMLAnchorElement;
    expect(historyLink.getAttribute("href")).toBe("/runs/run-0");

    // Starting a run reveals a lineage link for that run specifically.
    const start = await screen.findByRole("button", { name: /start run/i });
    await act(async () => {
      fireEvent.click(start);
    });

    const lineageLink = (await screen.findByRole("link", {
      name: /view run lineage/i,
    })) as HTMLAnchorElement;
    expect(lineageLink.getAttribute("href")).toBe("/runs/run-1");
  });

  it("surfaces a start error", async () => {
    installFetch({ runResponse: () => jsonResponse(400, { error: "no reviewed transform to run" }) });
    renderPage();

    const start = await screen.findByRole("button", { name: /start run/i });
    await act(async () => {
      fireEvent.click(start);
    });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("no reviewed transform to run");
    expect(screen.queryByRole("region", { name: /run progress/i })).toBeNull();
  });
});
