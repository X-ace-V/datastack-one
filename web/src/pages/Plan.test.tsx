// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { PlanPage } from "./Plan";
import type { Artifact, Project } from "../lib/api";

/**
 * Component test for the rules-input Plan page (T3.1, FR6). `fetch` is mocked so the test
 * asserts the desired behavior against the real API contract: the page loads projects and the
 * current rules doc on mount, saving typed text posts a JSON `{ rules }` body, and uploading a
 * file posts a multipart body — both to `POST /api/projects/:id/rules`.
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

function makeArtifact(over: Partial<Artifact> = {}): Artifact {
  return {
    id: "a-1",
    projectId: "p-1",
    runId: null,
    kind: "rules",
    path: "data/artifacts/p-1/a-1-rules.txt",
    content: "keep only active loans",
    createdAt: "2026-07-17 00:00:00",
    ...over,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

interface PostCall {
  url: string;
  method: string;
  body: unknown;
}

function installFetch(opts: {
  projects?: Project[];
  currentRules?: Artifact | null;
  onPost: () => Response;
  postCalls: PostCall[];
}) {
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "POST") {
      opts.postCalls.push({ url, method, body: init?.body });
      return opts.onPost();
    }
    if (url.endsWith("/rules")) {
      return jsonResponse(200, { rules: opts.currentRules ?? null });
    }
    return jsonResponse(200, { projects: opts.projects ?? [] });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderPage() {
  return render(
    <MemoryRouter>
      <PlanPage />
    </MemoryRouter>,
  );
}

describe("plan rules page", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("prompts to create a project when none exist", async () => {
    installFetch({ projects: [], onPost: () => jsonResponse(201, makeArtifact()), postCalls: [] });
    renderPage();
    expect(await screen.findByText(/create a project first/i)).toBeTruthy();
  });

  it("loads the current rules doc into the textarea on mount", async () => {
    installFetch({
      projects: [makeProject()],
      currentRules: makeArtifact({ content: "existing rules on file" }),
      onPost: () => jsonResponse(201, makeArtifact()),
      postCalls: [],
    });
    renderPage();
    const textarea = (await screen.findByLabelText(/transformation rules/i)) as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.value).toBe("existing rules on file"));
  });

  it("saves typed rules as a JSON body and shows the continue link", async () => {
    const postCalls: PostCall[] = [];
    installFetch({
      projects: [makeProject()],
      currentRules: null,
      onPost: () => jsonResponse(201, makeArtifact({ content: "drop rows where dpd_days > 90" })),
      postCalls,
    });
    renderPage();

    const textarea = (await screen.findByLabelText(/transformation rules/i)) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "drop rows where dpd_days > 90" } });

    const save = screen.getByRole("button", { name: /save rules/i });
    fireEvent.click(save);

    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("Rules saved");
    expect(screen.getByRole("link", { name: /continue to review/i })).toBeTruthy();

    // Exactly one JSON POST to the selected project's rules route carrying the text.
    expect(postCalls).toHaveLength(1);
    expect(postCalls[0]?.url).toBe("/api/projects/p-1/rules");
    expect(JSON.parse(String(postCalls[0]?.body))).toEqual({
      rules: "drop rows where dpd_days > 90",
    });
  });

  it("disables save until non-whitespace rules are entered", async () => {
    installFetch({
      projects: [makeProject()],
      currentRules: null,
      onPost: () => jsonResponse(201, makeArtifact()),
      postCalls: [],
    });
    renderPage();

    const save = (await screen.findByRole("button", { name: /save rules/i })) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    const textarea = screen.getByLabelText(/transformation rules/i);
    fireEvent.change(textarea, { target: { value: "   " } });
    expect(save.disabled).toBe(true);

    fireEvent.change(textarea, { target: { value: "real rule" } });
    expect(save.disabled).toBe(false);
  });

  it("uploads a rules file as multipart", async () => {
    const postCalls: PostCall[] = [];
    installFetch({
      projects: [makeProject()],
      currentRules: null,
      onPost: () => jsonResponse(201, makeArtifact({ content: "rules from file" })),
      postCalls,
    });
    renderPage();

    const input = (await screen.findByLabelText(/rules file/i)) as HTMLInputElement;
    const file = new File(["rules from file"], "loan_rules.txt", { type: "text/plain" });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(postCalls).toHaveLength(1));
    expect(postCalls[0]?.url).toBe("/api/projects/p-1/rules");
    expect(postCalls[0]?.body).toBeInstanceOf(FormData);
    const posted = (postCalls[0]?.body as FormData).get("file") as File;
    expect(posted.name).toBe("loan_rules.txt");

    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("Rules saved");
  });

  it("generates a plan and renders its pattern, warehouse and steps", async () => {
    const postCalls: PostCall[] = [];
    const plan = {
      executionPattern: "ELT",
      warehouse: "duckdb",
      partitioning: "Partition landed Parquet by ingestion date.",
      steps: [
        { name: "Extract", description: "Read the uploaded CSV." },
        { name: "Land Parquet", description: "Write Parquet partitioned by date." },
        { name: "Publish", description: "Serve the final table." },
      ],
      summary: "An ELT pipeline into DuckDB.",
    };
    installFetch({
      projects: [makeProject()],
      currentRules: null,
      onPost: () => jsonResponse(200, { plan, artifact: makeArtifact({ kind: "plan" }) }),
      postCalls,
    });
    renderPage();

    const generate = await screen.findByRole("button", { name: /generate architecture plan/i });
    fireEvent.click(generate);

    const region = await screen.findByRole("region", { name: /generated plan/i });
    expect(region.textContent).toContain("ELT");
    expect(region.textContent).toContain("duckdb");
    expect(region.textContent).toContain("Extract");
    expect(region.textContent).toContain("Publish");

    // Exactly one JSON POST to the selected project's plan route.
    expect(postCalls).toHaveLength(1);
    expect(postCalls[0]?.url).toBe("/api/projects/p-1/plan");
    expect(JSON.parse(String(postCalls[0]?.body))).toEqual({});
  });

  it("generates a transform and renders its SQL, assumptions and questions", async () => {
    const postCalls: PostCall[] = [];
    const transform = {
      sql: "CREATE OR REPLACE TABLE marts.loan_summary AS SELECT branch, sum(balance) FROM raw.source GROUP BY branch;",
      targetTable: "loan_summary",
      assumptions: ["A null balance is treated as zero."],
      questions: ["Should closed loans be excluded?"],
    };
    installFetch({
      projects: [makeProject()],
      currentRules: null,
      onPost: () =>
        jsonResponse(200, { transform, artifact: makeArtifact({ kind: "transform_sql" }) }),
      postCalls,
    });
    renderPage();

    const generate = await screen.findByRole("button", { name: /generate transform sql/i });
    fireEvent.click(generate);

    const region = await screen.findByRole("region", { name: /generated transform/i });
    expect(region.textContent).toContain("marts.loan_summary");
    expect(region.textContent).toContain("A null balance is treated as zero.");
    expect(region.textContent).toContain("Should closed loans be excluded?");

    // Exactly one JSON POST to the selected project's transform route.
    expect(postCalls).toHaveLength(1);
    expect(postCalls[0]?.url).toBe("/api/projects/p-1/transform");
    expect(JSON.parse(String(postCalls[0]?.body))).toEqual({});
  });

  it("surfaces a plan-generation error", async () => {
    installFetch({
      projects: [makeProject()],
      currentRules: null,
      onPost: () => jsonResponse(422, { error: "could not generate a plan" }),
      postCalls: [],
    });
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: /generate architecture plan/i }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("could not generate a plan");
  });

  it("surfaces a backend error", async () => {
    installFetch({
      projects: [makeProject()],
      currentRules: null,
      onPost: () => jsonResponse(400, { error: "the rules document is empty" }),
      postCalls: [],
    });
    renderPage();

    const textarea = await screen.findByLabelText(/transformation rules/i);
    fireEvent.change(textarea, { target: { value: "something" } });
    fireEvent.click(screen.getByRole("button", { name: /save rules/i }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("the rules document is empty");
  });
});
