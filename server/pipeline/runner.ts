import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { WarehouseStore } from "../store/duckdb.js";
import type { Source } from "../core/sources.js";
import type { Transform } from "../core/transform.js";
import type { DqSpec } from "../core/dq.js";
import type { ApprovalAction } from "../core/approvals.js";
import {
  PIPELINE_STAGES,
  type RunApprovalRequest,
  type RunEvent,
  type RunState,
  type RunStep,
} from "../core/run.js";
import { safeDatasetName } from "../core/landing.js";
import { landParquet } from "../tools/land.js";
import { loadWarehouse } from "../tools/warehouse.js";
import { runTransform } from "../tools/transform.js";
import { runDqCheck } from "../tools/dq.js";
import { planPublishServing, publishServing } from "../tools/serve.js";
import {
  completeRunStep,
  getRunState,
  startRunStep,
  updateRunStatus,
} from "../store/runs.js";

/**
 * The scripted pipeline runner (TASKS T4.4/T5.1/T5.2, PRD FR7/FR8/FR9/FR10, ARCHITECTURE §3.3, §4).
 * It drives the run through its ordered stages deterministically — Extract → Land → Load →
 * Transform → DQ → Publish, the six visible tasks. Each stage's status is persisted to
 * `platform.run_steps` and emitted for the SSE stream (FR9); before every `ask` tool
 * (land/load/transform/publish) the runner parks on {@link RunPipelineDeps.approve} and does not
 * execute until a human approves, so nothing writes or executes unapproved (FR8). A reject aborts
 * the run; a data-quality failure in the DQ stage also aborts it, so Publish never runs on bad data
 * (FR7). An I/O module (DuckDB via the tools + the run store), so it lives under `server/pipeline`;
 * the schemas and stage list are the pure {@link file://../core/run.ts}.
 */

/** Everything the runner needs to execute one run to completion. */
export interface RunPipelineDeps {
  /** Warehouse store — the tools and the run-state persistence both use it. */
  store: WarehouseStore;
  /** The already-created run's id. */
  runId: string;
  /** The already-created, pending run steps (one per {@link PIPELINE_STAGES} entry). */
  steps: RunStep[];
  /** The resolved source whose CSV is landed (its `path` is read). */
  source: Source;
  /** The reviewed transform (SQL + target table) to execute in the Transform stage. */
  transform: Transform;
  /** The reviewed DQ spec (target table + ≥3 checks) executed in the DQ stage; a failure aborts the run. */
  dqSpec: DqSpec;
  /** Landing root the land stage writes Parquet under. */
  landingDir: string;
  /** Serving root the publish stage writes the CSV export under (FR10). */
  servingDir: string;
  /** Ingestion date to partition under; defaults to today (UTC) when omitted. */
  ingestionDate?: string;
  /** Called before each gated stage; resolves to the human's decision. Reject aborts the run. */
  approve: (request: RunApprovalRequest) => Promise<ApprovalAction>;
  /** Optional sink for run-progress events (wired to the SSE bridge in production). */
  emit?: (event: RunEvent) => void;
}

/** Internal marker distinguishing a human rejection from a technical stage failure. */
class StageRejectedError extends Error {
  constructor(tool: string) {
    super(`${tool} was rejected at the approval gate`);
    this.name = "StageRejectedError";
  }
}

/**
 * Raised when one or more data-quality checks fail (FR7). Carries the failed check names so the
 * step detail explains what blocked the run. It fails the DQ stage — and therefore the run — so
 * the later Publish stage never executes: the "block publish on DQ failure" guard.
 */
class DqChecksFailedError extends Error {
  constructor(failed: string[]) {
    super(`data-quality checks failed: ${failed.join(", ")}`);
    this.name = "DqChecksFailedError";
  }
}

/**
 * Execute the run. Returns the final {@link RunState} (persisted run + steps). The run's status
 * ends `success` when every stage passed, `rejected` when a human denied a gated stage, or
 * `failed` when a stage errored. Never throws for an expected stage failure/rejection — those are
 * recorded as run/step state — so a background caller can `void` it safely; it only rejects if the
 * store itself is unreachable.
 */
export async function runPipeline(deps: RunPipelineDeps): Promise<RunState> {
  const { store, runId } = deps;
  const emit = (event: RunEvent): void => deps.emit?.(event);
  const stepByName = new Map(deps.steps.map((step) => [step.name, step]));

  /** Run one stage: mark it running, execute `body`, then record success/failure + emit both. */
  async function stage(name: string, body: () => Promise<string>): Promise<void> {
    const step = stepByName.get(name);
    if (!step) throw new Error(`run ${runId} is missing the "${name}" step`);
    await startRunStep(store, step.id);
    emit({ kind: "step.status", runId, stepId: step.id, name, status: "running", detail: null });
    try {
      const detail = await body();
      await completeRunStep(store, step.id, "success", detail);
      emit({ kind: "step.status", runId, stepId: step.id, name, status: "success", detail });
    } catch (err) {
      const detail =
        err instanceof StageRejectedError
          ? "rejected by human at the approval gate"
          : err instanceof Error
            ? err.message
            : String(err);
      await completeRunStep(store, step.id, "failed", detail);
      emit({ kind: "step.status", runId, stepId: step.id, name, status: "failed", detail });
      throw err;
    }
  }

  /** Park a gated stage on the approval gate; throw {@link StageRejectedError} if denied. */
  async function gate(
    step: RunStep,
    tool: string,
    summary: string,
    sql: string | null,
    args: Record<string, unknown>,
  ): Promise<void> {
    const request: RunApprovalRequest = {
      requestID: randomUUID(),
      runId,
      stepId: step.id,
      stepName: step.name,
      tool,
      summary,
      sql,
      args,
    };
    emit({ kind: "approval.requested", runId, request });
    const action = await deps.approve(request);
    emit({ kind: "approval.resolved", runId, requestID: request.requestID, action });
    if (action === "reject") throw new StageRejectedError(tool);
  }

  await updateRunStatus(store, runId, "running");
  emit({ kind: "run.status", runId, status: "running" });

  const dataset = safeDatasetName(deps.source.originalFilename ?? deps.source.id);
  let landingPath: string | undefined;

  try {
    // Extract — read-only: confirm the uploaded CSV is present and readable, count its rows.
    await stage("extract", async () => {
      const rows = await store.all(
        `SELECT count(*)::BIGINT AS n FROM read_csv_auto(?)`,
        [deps.source.path],
      );
      const n = Number(rows[0]?.n ?? 0);
      return `read ${n} rows from ${basename(deps.source.path)}`;
    });

    // Land — gated: write the raw CSV to landing as partitioned Parquet.
    await stage("land", async () => {
      const step = stepByName.get("land")!;
      await gate(step, "land_parquet", `Land ${dataset} as ingestion-date-partitioned Parquet`, null, {
        sourcePath: deps.source.path,
        dataset,
        ingestionDate: deps.ingestionDate ?? null,
      });
      const res = await landParquet(store, {
        landingDir: deps.landingDir,
        sourcePath: deps.source.path,
        dataset,
        ingestionDate: deps.ingestionDate,
      });
      landingPath = res.landingPath;
      return `landed ${res.rowCount} rows → ${res.partitionPath}`;
    });

    // Load — gated: materialize the landed Parquet into raw.source.
    await stage("load", async () => {
      const step = stepByName.get("load")!;
      if (!landingPath) throw new Error("no landed Parquet to load");
      await gate(step, "load_warehouse", `Load landed Parquet into raw.source`, null, {
        landingPath,
      });
      const res = await loadWarehouse(store, { landingPath });
      return `loaded ${res.rowCount} rows → ${res.qualifiedTable}`;
    });

    // Transform — gated: execute the reviewed SQL into marts. The exact SQL is shown for approval.
    await stage("transform", async () => {
      const step = stepByName.get("transform")!;
      await gate(step, "run_transform", `Execute the reviewed transform SQL into marts`, deps.transform.sql, {
        targetTable: deps.transform.targetTable,
      });
      const res = await runTransform(store, {
        sql: deps.transform.sql,
        targetTable: deps.transform.targetTable,
      });
      return `materialized ${res.rowCount} rows → ${res.qualifiedTable}`;
    });

    // DQ — read-only, not gated: run the reviewed checks. Any failure throws, failing the run so
    // a later Publish stage never executes (FR7: DQ failure blocks publish).
    await stage("dq", async () => {
      const result = await runDqCheck(store, { spec: deps.dqSpec });
      const failed = result.results.filter((r) => !r.passed);
      if (!result.passed) {
        throw new DqChecksFailedError(failed.map((r) => r.name));
      }
      return `${result.results.length} DQ checks passed against ${result.targetTable}`;
    });

    // Publish — gated: export the marts table to CSV and register its REST endpoint (FR10).
    // Only reachable once every DQ check passed, since a failure aborts the run above (FR7).
    await stage("publish", async () => {
      const step = stepByName.get("publish")!;
      const plan = planPublishServing({
        servingDir: deps.servingDir,
        projectId: deps.source.projectId,
        runId,
        table: deps.transform.targetTable,
      });
      await gate(
        step,
        "publish_serving",
        `Publish ${plan.qualifiedTable} at ${plan.endpoint} and export it to CSV`,
        plan.sql,
        { table: plan.table, name: plan.name, format: plan.format, csvPath: plan.csvPath },
      );
      const served = await publishServing(store, {
        servingDir: deps.servingDir,
        projectId: deps.source.projectId,
        runId,
        table: deps.transform.targetTable,
      });
      return `published ${served.rowCount} rows → ${served.endpoint} (CSV ${served.csvPath})`;
    });

    await updateRunStatus(store, runId, "success");
    emit({ kind: "run.status", runId, status: "success" });
  } catch (err) {
    const status = err instanceof StageRejectedError ? "rejected" : "failed";
    await updateRunStatus(store, runId, status);
    emit({ kind: "run.status", runId, status });
  }

  const state = await getRunState(store, runId);
  if (!state) throw new Error(`run ${runId} vanished during execution`);
  return state;
}
