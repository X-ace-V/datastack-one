// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ReviewPage } from "./Review";
import type { Artifact, Project } from "../lib/api";

/**
 * Component test for the Review page (T3.5, FR3/FR6/FR7). `fetch` is mocked so the test asserts
 * the desired behavior against the real API contract: the page loads the project's generated
 * artifacts from `GET /api/projects/:id/artifacts`, renders the parsed plan/transform/DDL/DQ
 * payloads, gates the Approve button until the plan, transform and DQ spec all exist, and only
 * reveals the Continue-to-Run link once approved.
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

function makeArtifact(kind: string, content: string, over: Partial<Artifact> = {}): Artifact {
  return {
    id: `a-${kind}`,
    projectId: "p-1",
    runId: null,
    kind,
    path: `data/artifacts/p-1/a-${kind}.json`,
    content,
    createdAt: "2026-07-17 00:00:00",
    ...over,
  };
}

const PLAN = {
  executionPattern: "ELT",
  warehouse: "duckdb",
  partitioning: "Partition landed Parquet by ingestion date.",
  steps: [
    { name: "Extract", description: "Read the uploaded CSV." },
    { name: "Publish", description: "Serve the final table." },
  ],
  summary: "An ELT pipeline into DuckDB.",
};

const TRANSFORM = {
  sql: "CREATE OR REPLACE TABLE marts.loan_summary AS SELECT branch, sum(balance) FROM raw.source GROUP BY branch;",
  targetTable: "loan_summary",
  assumptions: ["A null balance is treated as zero."],
  questions: ["Should closed loans be excluded?"],
};

const DQ = {
  targetTable: "raw.source",
  checks: [
    { name: "rows present", type: "row_count", column: null, description: "at least one row" },
    { name: "id not null", type: "not_null", column: "loan_id", description: "loan_id never null" },
    { name: "branch present", type: "schema", column: "branch", description: "branch column exists" },
  ],
};

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

interface ArtifactsBody {
  plan: Artifact | null;
  transform: Artifact | null;
  ddl: Artifact | null;
  dq: Artifact | null;
}

function installFetch(opts: { projects?: Project[]; artifacts: ArtifactsBody }) {
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.endsWith("/artifacts")) {
      return jsonResponse(200, opts.artifacts);
    }
    return jsonResponse(200, { projects: opts.projects ?? [] });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderPage() {
  return render(
    <MemoryRouter>
      <ReviewPage />
    </MemoryRouter>,
  );
}

const ALL_ARTIFACTS: ArtifactsBody = {
  plan: makeArtifact("plan", JSON.stringify(PLAN)),
  transform: makeArtifact("transform_sql", JSON.stringify(TRANSFORM)),
  ddl: makeArtifact("ddl", "CREATE TABLE marts.loan_summary (branch VARCHAR, total DOUBLE);"),
  dq: makeArtifact("dq_spec", JSON.stringify(DQ)),
};

describe("review page", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("prompts to create a project when none exist", async () => {
    installFetch({ projects: [], artifacts: ALL_ARTIFACTS });
    renderPage();
    expect(await screen.findByText(/create a project first/i)).toBeTruthy();
  });

  it("renders the plan, transform SQL, DDL and DQ checks for review", async () => {
    installFetch({ projects: [makeProject()], artifacts: ALL_ARTIFACTS });
    renderPage();

    const planRegion = await screen.findByRole("region", { name: /plan artifact/i });
    expect(planRegion.textContent).toContain("ELT");
    expect(planRegion.textContent).toContain("Extract");
    expect(planRegion.textContent).toContain("An ELT pipeline into DuckDB.");

    const transformRegion = screen.getByRole("region", { name: /transform artifact/i });
    expect(transformRegion.textContent).toContain("marts.loan_summary");
    expect(transformRegion.textContent).toContain("A null balance is treated as zero.");
    expect(transformRegion.textContent).toContain("Should closed loans be excluded?");

    const ddlRegion = screen.getByRole("region", { name: /ddl artifact/i });
    expect(ddlRegion.textContent).toContain("CREATE TABLE marts.loan_summary");

    const dqRegion = screen.getByRole("region", { name: /dq artifact/i });
    expect(dqRegion.textContent).toContain("raw.source");
    expect(dqRegion.textContent).toContain("row_count");
    expect(dqRegion.textContent).toContain("loan_id");
  });

  it("approves and reveals the continue-to-run link once all artifacts exist", async () => {
    installFetch({ projects: [makeProject()], artifacts: ALL_ARTIFACTS });
    renderPage();

    const approve = (await screen.findByRole("button", {
      name: /approve artifacts/i,
    })) as HTMLButtonElement;
    expect(approve.disabled).toBe(false);

    // No run link until the human approves.
    expect(screen.queryByRole("link", { name: /continue to run/i })).toBeNull();

    fireEvent.click(approve);

    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("Artifacts approved");
    expect(screen.getByRole("link", { name: /continue to run/i })).toBeTruthy();
    // Button reflects the approved state and can't be clicked again.
    expect((screen.getByRole("button", { name: /approved/i }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("disables approval and links back to Plan when artifacts are missing", async () => {
    installFetch({
      projects: [makeProject()],
      // Only a plan was generated — transform and DQ are still missing.
      artifacts: { plan: ALL_ARTIFACTS.plan, transform: null, ddl: null, dq: null },
    });
    renderPage();

    const approve = (await screen.findByRole("button", {
      name: /approve artifacts/i,
    })) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    expect(screen.getByText(/have not been generated yet/i)).toBeTruthy();
    expect(screen.getByRole("link", { name: /generate the plan/i })).toBeTruthy();
  });

  it("surfaces a load error", async () => {
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith("/artifacts")) {
        return jsonResponse(500, { error: "failed to load artifacts" });
      }
      return jsonResponse(200, { projects: [makeProject()] });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPage();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("failed to load artifacts");
  });
});
