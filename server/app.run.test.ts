import { afterEach, describe, expect, it } from "vitest";
import { buildServer, type RunLauncher } from "./app.js";
import { openStore, type WarehouseStore } from "./store/duckdb.js";
import { insertProject } from "./store/projects.js";
import { CreateProjectRequestSchema } from "./core/projects.js";
import { insertSource } from "./store/sources.js";
import { insertArtifact } from "./store/artifacts.js";
import { getRunState } from "./store/runs.js";
import { createRunApprovalGate, type RunApprovalGate } from "./pipeline/run-approvals.js";
import type { Transform } from "./core/transform.js";
import type { DqSpec } from "./core/dq.js";
import type { RunApprovalRequest } from "./core/run.js";

/**
 * Route tests for the pipeline run surface (T4.4) over a real in-memory warehouse. The runner
 * itself is tested in {@link file://./pipeline/runner.test.ts}; here we inject a launcher spy so
 * the routes are asserted without executing a real pipeline, and a real approval gate so the
 * approve/reject flow is exercised end to end.
 */
describe("run routes", () => {
  const open: WarehouseStore[] = [];

  afterEach(async () => {
    await Promise.all(open.splice(0).map((s) => s.close()));
  });

  const TRANSFORM: Transform = {
    sql: "CREATE OR REPLACE TABLE marts.x AS SELECT 1 AS a",
    targetTable: "x",
    assumptions: [],
    questions: [],
  };

  const DQ_SPEC: DqSpec = {
    targetTable: "raw.source",
    checks: [
      { name: "rows present", type: "row_count", column: null, description: "at least one row" },
      { name: "id not null", type: "not_null", column: "loan_id", description: "loan_id not null" },
      { name: "branch present", type: "schema", column: "branch", description: "branch exists" },
      { name: "fresh", type: "freshness", column: "opened_at", description: "date present" },
    ],
  };

  /**
   * A store seeded with a project, a source, and (optionally) a reviewed transform + DQ artifact.
   * `transform`/`dq` default to the valid fixtures; pass `null` to omit one, or a raw string to
   * store malformed content.
   */
  async function seeded(
    opts: { transform?: string | null; dq?: string | null } = {},
  ): Promise<{
    store: WarehouseStore;
    projectId: string;
    sourceId: string;
  }> {
    const store = await openStore(":memory:");
    open.push(store);
    const project = await insertProject(
      store,
      CreateProjectRequestSchema.parse({ name: "Loans", domain: "lending" }),
    );
    const source = await insertSource(store, {
      id: "src1",
      projectId: project.id,
      path: "/tmp/loans.csv",
      originalFilename: "loans.csv",
    });
    const transformContent =
      opts.transform === undefined ? JSON.stringify(TRANSFORM) : opts.transform;
    if (transformContent !== null) {
      await insertArtifact(store, {
        id: "art1",
        projectId: project.id,
        kind: "transform_sql",
        content: transformContent,
      });
    }
    const dqContent = opts.dq === undefined ? JSON.stringify(DQ_SPEC) : opts.dq;
    if (dqContent !== null) {
      await insertArtifact(store, {
        id: "art2",
        projectId: project.id,
        kind: "dq_spec",
        content: dqContent,
      });
    }
    return { store, projectId: project.id, sourceId: source.id };
  }

  /** A launcher spy that records its calls without running anything. */
  function spyLauncher(): { launchRun: RunLauncher; calls: Parameters<RunLauncher>[0][] } {
    const calls: Parameters<RunLauncher>[0][] = [];
    return { launchRun: (input) => void calls.push(input), calls };
  }

  describe("POST /api/projects/:id/run", () => {
    it("creates the run + steps and launches the pipeline (202)", async () => {
      const { store, projectId } = await seeded();
      const { launchRun, calls } = spyLauncher();
      const app = buildServer({ store, launchRun });

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/run`,
        payload: {},
      });

      expect(res.statusCode).toBe(202);
      const body = res.json();
      expect(body.run.status).toBe("pending");
      expect(body.steps.map((s: { name: string }) => s.name)).toEqual([
        "extract",
        "land",
        "load",
        "transform",
        "dq",
        "publish",
      ]);

      // The launcher was handed the created run, steps, resolved source, parsed transform + DQ spec.
      expect(calls).toHaveLength(1);
      expect(calls[0]!.run.id).toBe(body.run.id);
      expect(calls[0]!.steps).toHaveLength(6);
      expect(calls[0]!.source.id).toBe("src1");
      expect(calls[0]!.transform).toEqual(TRANSFORM);
      expect(calls[0]!.dqSpec).toEqual(DQ_SPEC);

      // The run + steps were persisted before the launch.
      const state = await getRunState(store, body.run.id);
      expect(state?.steps).toHaveLength(6);
    });

    it("records the per-run model on the run, and null when none is sent", async () => {
      const { store, projectId } = await seeded();
      const { launchRun } = spyLauncher();
      const app = buildServer({ store, launchRun });

      // FR11: the model the UI picked for generation is recorded on the run it produced (T6.3).
      const picked = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/run`,
        payload: { model: "anthropic/claude-opus-4-5" },
      });
      expect(picked.statusCode).toBe(202);
      expect(picked.json().run.model).toBe("anthropic/claude-opus-4-5");
      // Persisted, not just echoed back to the caller.
      const stored = await getRunState(store, picked.json().run.id);
      expect(stored?.run.model).toBe("anthropic/claude-opus-4-5");

      // No explicit choice stays null so the runtime's own default applies — the UI never
      // duplicates the platform default by naming it here.
      const defaulted = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/run`,
        payload: {},
      });
      expect(defaulted.json().run.model).toBeNull();
    });

    it("404s an unknown project and a cross-project source", async () => {
      const { store, projectId } = await seeded();
      const { launchRun } = spyLauncher();
      const app = buildServer({ store, launchRun });

      expect(
        (await app.inject({ method: "POST", url: `/api/projects/nope/run`, payload: {} }))
          .statusCode,
      ).toBe(404);
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/projects/${projectId}/run`,
            payload: { sourceId: "other" },
          })
        ).statusCode,
      ).toBe(404);
    });

    it("400s when there is no reviewed transform to run", async () => {
      const { store, projectId } = await seeded({ transform: null });
      const { launchRun, calls } = spyLauncher();
      const app = buildServer({ store, launchRun });

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/run`,
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      expect(calls).toHaveLength(0);
    });

    it("422s when the stored transform artifact is not a valid transform", async () => {
      const { store, projectId } = await seeded({ transform: "{ not valid json" });
      const { launchRun } = spyLauncher();
      const app = buildServer({ store, launchRun });

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/run`,
        payload: {},
      });
      expect(res.statusCode).toBe(422);
    });

    it("400s when there is no reviewed DQ spec to run", async () => {
      const { store, projectId } = await seeded({ dq: null });
      const { launchRun, calls } = spyLauncher();
      const app = buildServer({ store, launchRun });

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/run`,
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      expect(calls).toHaveLength(0);
    });

    it("422s when the stored DQ artifact is not a valid DQ spec", async () => {
      const { store, projectId } = await seeded({ dq: "{ not valid json" });
      const { launchRun } = spyLauncher();
      const app = buildServer({ store, launchRun });

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/run`,
        payload: {},
      });
      expect(res.statusCode).toBe(422);
    });

    it("503s when the store or the runner is unwired", async () => {
      const noStore = buildServer({ launchRun: spyLauncher().launchRun });
      expect(
        (await noStore.inject({ method: "POST", url: `/api/projects/p/run`, payload: {} }))
          .statusCode,
      ).toBe(503);
      const { store, projectId } = await seeded();
      const noRunner = buildServer({ store });
      expect(
        (
          await noRunner.inject({
            method: "POST",
            url: `/api/projects/${projectId}/run`,
            payload: {},
          })
        ).statusCode,
      ).toBe(503);
    });
  });

  describe("GET /api/runs/:runId", () => {
    it("returns the run state plus any pending approvals", async () => {
      const { store, projectId } = await seeded();
      const gate = createRunApprovalGate();
      const { launchRun } = spyLauncher();
      const app = buildServer({ store, launchRun, runApprovals: gate });

      const start = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/run`,
        payload: {},
      });
      const runId = start.json().run.id;

      // Park a pending approval for this run on the gate.
      const request: RunApprovalRequest = {
        requestID: "req1",
        runId,
        stepId: "s",
        stepName: "land",
        tool: "land_parquet",
        summary: "Land it",
        sql: null,
        args: {},
      };
      void gate.request(request);

      const res = await app.inject({ method: "GET", url: `/api/runs/${runId}` });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.run.id).toBe(runId);
      expect(body.steps).toHaveLength(6);
      expect(body.approvals).toHaveLength(1);
      expect(body.approvals[0].requestID).toBe("req1");
    });

    it("404s an unknown run and 503s without a store", async () => {
      const { store } = await seeded();
      const app = buildServer({ store });
      expect((await app.inject({ method: "GET", url: `/api/runs/nope` })).statusCode).toBe(404);
      expect(
        (await buildServer({}).inject({ method: "GET", url: `/api/runs/x` })).statusCode,
      ).toBe(503);
    });
  });

  describe("POST /api/runs/:runId/approvals/:requestID", () => {
    /** Build an app with a gate holding one pending approval for run `run1`. */
    async function withPending(): Promise<{
      app: ReturnType<typeof buildServer>;
      gate: RunApprovalGate;
      store: WarehouseStore;
      settled: Promise<string>;
    }> {
      const store = await openStore(":memory:");
      open.push(store);
      await store.run(
        `INSERT INTO platform.projects (id, name, domain) VALUES ('p1','Loans','lending')`,
      );
      await store.run(`INSERT INTO platform.runs (id, project_id) VALUES ('run1','p1')`);
      const gate = createRunApprovalGate();
      const app = buildServer({ store, runApprovals: gate });
      const settled = gate.request({
        requestID: "req1",
        runId: "run1",
        stepId: "s",
        stepName: "transform",
        tool: "run_transform",
        summary: "Run it",
        sql: "SELECT 1",
        args: { targetTable: "x" },
      });
      return { app, gate, store, settled };
    }

    it("approves a pending request, unblocks the runner, and audits it", async () => {
      const { app, store, settled } = await withPending();

      const res = await app.inject({
        method: "POST",
        url: `/api/runs/run1/approvals/req1`,
        payload: { action: "approve" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ requestID: "req1", status: "approved" });
      await expect(settled).resolves.toBe("approve");

      // The decision was recorded to the audit trail.
      const rows = await store.all(
        `SELECT tool, action FROM platform.approvals WHERE request_id = 'req1'`,
      );
      expect(rows).toEqual([{ tool: "run_transform", action: "approve" }]);
    });

    it("rejects a pending request", async () => {
      const { app, settled } = await withPending();
      const res = await app.inject({
        method: "POST",
        url: `/api/runs/run1/approvals/req1`,
        payload: { action: "reject" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe("rejected");
      await expect(settled).resolves.toBe("reject");
    });

    it("404s an unknown request or one belonging to a different run", async () => {
      const { app } = await withPending();
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/runs/run1/approvals/missing`,
            payload: { action: "approve" },
          })
        ).statusCode,
      ).toBe(404);
      // req1 exists but under run1, not run2.
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/runs/run2/approvals/req1`,
            payload: { action: "approve" },
          })
        ).statusCode,
      ).toBe(404);
    });

    it("400s a bad decision and 503s without a gate", async () => {
      const { app } = await withPending();
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/runs/run1/approvals/req1`,
            payload: { action: "maybe" },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await buildServer({}).inject({
            method: "POST",
            url: `/api/runs/run1/approvals/req1`,
            payload: { action: "approve" },
          })
        ).statusCode,
      ).toBe(503);
    });
  });
});
