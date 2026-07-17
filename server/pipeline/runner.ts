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
import {
  completeToolCall,
  recordDqResults,
  startToolCall,
} from "../store/lineage.js";

/**
 * The scripted pipeline runner (TASKS T4.4/T5.1/T5.2, PRD FR7/FR8/FR9/FR10, ARCHITECTURE §3.3, §4).
 * It drives the run through its ordered stages deterministically — Extract → Land → Load →
 * Transform → DQ → Publish, the six visible tasks. Each stage's status is persisted to
 * `platform.run_steps` and emitted for the SSE stream (FR9); before every `ask` tool
 * (land/load/transform/publish) the runner parks on {@link RunPipelineDeps.approve} and does not
 * execute until a human approves, so nothing writes or executes unapproved (FR8). A reject aborts
 * the run; a data-quality failure in the DQ stage also aborts it, so Publish never runs on bad data
 * (FR7). Alongside the step status it records the run's lineage (T5.5, FR12): every tool call it
 * executes and every DQ check outcome, so a finished run can be audited after the fact — see
 * {@link file://../store/lineage.ts}. An I/O module (DuckDB via the tools + the run store), so it
 * lives under `server/pipeline`; the schemas and stage list are the pure
 * {@link file://../core/run.ts} and {@link file://../core/lineage.ts}.
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

  /**
   * Execute one tool and record the call to the run's lineage (FR12). The record opens `running`
   * before the tool runs — so a call that dies mid-flight still leaves a trace — and closes with
   * the outcome `describe` derives, or with the error message when the tool throws. Returns both
   * the tool's value and that sentence, so a stage reports the same outcome it recorded rather than
   * re-deriving a look-alike string.
   */
  async function toolCall<T>(
    step: RunStep,
    tool: string,
    args: Record<string, unknown>,
    execute: () => Promise<T>,
    describe: (value: T) => string,
  ): Promise<{ value: T; detail: string }> {
    const record = await startToolCall(store, {
      id: randomUUID(),
      runId,
      stepId: step.id,
      tool,
      args,
    });
    let value: T;
    try {
      value = await execute();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await completeToolCall(store, record.id, "failed", { error: message });
      throw err;
    }
    const detail = describe(value);
    await completeToolCall(store, record.id, "success", { result: detail });
    return { value, detail };
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

    // Land — gated: write the raw CSV to landing as partitioned Parquet. The args a human approves
    // are the args the tool call records and runs, so the lineage shows exactly what was consented to.
    await stage("land", async () => {
      const step = stepByName.get("land")!;
      const args = {
        sourcePath: deps.source.path,
        dataset,
        ingestionDate: deps.ingestionDate ?? null,
      };
      await gate(step, "land_parquet", `Land ${dataset} as ingestion-date-partitioned Parquet`, null, args);
      const { value: res, detail } = await toolCall(
        step,
        "land_parquet",
        args,
        () =>
          landParquet(store, {
            landingDir: deps.landingDir,
            sourcePath: deps.source.path,
            dataset,
            ingestionDate: deps.ingestionDate,
          }),
        (r) => `landed ${r.rowCount} rows → ${r.partitionPath}`,
      );
      landingPath = res.landingPath;
      return detail;
    });

    // Load — gated: materialize the landed Parquet into raw.source.
    await stage("load", async () => {
      const step = stepByName.get("load")!;
      if (!landingPath) throw new Error("no landed Parquet to load");
      const args = { landingPath };
      await gate(step, "load_warehouse", `Load landed Parquet into raw.source`, null, args);
      const { detail } = await toolCall(
        step,
        "load_warehouse",
        args,
        () => loadWarehouse(store, { landingPath: args.landingPath }),
        (r) => `loaded ${r.rowCount} rows → ${r.qualifiedTable}`,
      );
      return detail;
    });

    // Transform — gated: execute the reviewed SQL into marts. The exact SQL is shown for approval.
    await stage("transform", async () => {
      const step = stepByName.get("transform")!;
      const args = { targetTable: deps.transform.targetTable, sql: deps.transform.sql };
      await gate(step, "run_transform", `Execute the reviewed transform SQL into marts`, deps.transform.sql, {
        targetTable: deps.transform.targetTable,
      });
      const { detail } = await toolCall(
        step,
        "run_transform",
        args,
        () =>
          runTransform(store, {
            sql: deps.transform.sql,
            targetTable: deps.transform.targetTable,
          }),
        (r) => `materialized ${r.rowCount} rows → ${r.qualifiedTable}`,
      );
      return detail;
    });

    // DQ — read-only, not gated: run the reviewed checks. Any failure throws, failing the run so
    // a later Publish stage never executes (FR7: DQ failure blocks publish). Note the tool call
    // itself SUCCEEDS on a failing check — `run_dq_check` reports pass/fail rather than throwing —
    // so the record shows a successful call whose outcome then failed the stage.
    await stage("dq", async () => {
      const step = stepByName.get("dq")!;
      const { value: result, detail } = await toolCall(
        step,
        "run_dq_check",
        { targetTable: deps.dqSpec.targetTable, checks: deps.dqSpec.checks.length },
        () => runDqCheck(store, { spec: deps.dqSpec }),
        (r) => {
          const failedCount = r.results.filter((c) => !c.passed).length;
          return failedCount === 0
            ? `${r.results.length} DQ checks passed against ${r.targetTable}`
            : `${failedCount} of ${r.results.length} DQ checks failed against ${r.targetTable}`;
        },
      );

      // Record every check outcome — passing and failing — BEFORE a failure aborts the run (FR12).
      // The record of which check blocked publish is exactly what makes the FR7 block auditable.
      await recordDqResults(
        store,
        runId,
        result.results.map((r) => ({ ...r, id: randomUUID() })),
      );

      const failed = result.results.filter((r) => !r.passed);
      if (!result.passed) {
        throw new DqChecksFailedError(failed.map((r) => r.name));
      }
      return detail;
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
      const args = {
        table: plan.table,
        name: plan.name,
        format: plan.format,
        csvPath: plan.csvPath,
      };
      await gate(
        step,
        "publish_serving",
        `Publish ${plan.qualifiedTable} at ${plan.endpoint} and export it to CSV`,
        plan.sql,
        args,
      );
      const { detail } = await toolCall(
        step,
        "publish_serving",
        args,
        () =>
          publishServing(store, {
            servingDir: deps.servingDir,
            projectId: deps.source.projectId,
            runId,
            table: deps.transform.targetTable,
          }),
        (s) => `published ${s.rowCount} rows → ${s.endpoint} (CSV ${s.csvPath})`,
      );
      return detail;
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
