import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { WarehouseStore } from "../store/duckdb.js";
import { MARTS_SCHEMA } from "../core/transform.js";
import { safeTableName } from "../core/warehouse.js";
import {
  buildCsvExportSql,
  isServingFormat,
  safeServedName,
  servedCsvEndpoint,
  servedCsvFilename,
  servedEndpoint,
  DEFAULT_SERVING_FORMAT,
  type ServedTable,
  type ServingFormat,
} from "../core/serving.js";
import { registerServedTable } from "../store/serving.js";

/**
 * The `publish_serving` tool (PRD FR10, ARCHITECTURE §5) — the pipeline's final stage. It takes
 * the `marts` table the transform materialized and publishes it two ways: it **registers** the
 * table in `platform.served_tables` under a served name (which is what makes the generated
 * `GET /api/serve/:name` endpoint resolve — T5.3) and **exports** it to CSV on disk for download.
 *
 * It writes (a file, plus the registry row), so it is permission **`ask`** — it is on
 * {@link file://../opencode/config.ts}'s `ASK_TOOLS` and the run pauses for explicit human
 * approval before it executes (FR8). It only ever runs after the DQ stage passed: a failed check
 * aborts the run, so nothing publishes on bad data (FR7).
 *
 * An I/O module (fs + DuckDB `COPY`), so it lives under `server/tools`; the name sanitizer, the
 * endpoint derivation, the exact export SQL and the result shape are the pure
 * {@link file://../core/serving.ts}.
 */

/** Default serving root for generated exports. `data/` is gitignored; tests point this elsewhere. */
export const DEFAULT_SERVING_DIR = "data/serving";

/** Inputs the `publish_serving` tool needs to publish one marts table. */
export interface PublishServingInput {
  /** Serving root the CSV export is written under. */
  servingDir: string;
  /** Project publishing the table — its exports are namespaced under the serving root. */
  projectId: string;
  /** Run publishing it, or `null`/absent when published outside a run. */
  runId?: string | null;
  /** Unqualified `marts` table to serve (the transform's `targetTable`). */
  table: string;
  /** Served name (the endpoint's URL segment); defaults to the table name. Sanitized. */
  name?: string;
  /** Export format; defaults to CSV, the MVP's served artifact. */
  format?: ServingFormat;
}

/**
 * Everything a publish will do, derived from its inputs — the served name, the table it reads,
 * where the CSV lands, the endpoints it will answer at, and the **exact SQL** that will run.
 */
export interface PublishPlan {
  /** Sanitized served name. */
  name: string;
  /** Sanitized unqualified marts table. */
  table: string;
  /** Fully-qualified `marts.<table>` the export reads. */
  qualifiedTable: string;
  /** Export format. */
  format: ServingFormat;
  /** On-disk destination of the CSV export. */
  csvPath: string;
  /** REST endpoint the published table answers at. */
  endpoint: string;
  /** Endpoint the published table downloads as CSV from. */
  csvEndpoint: string;
  /** The exact `COPY ... (FORMAT CSV, HEADER)` statement {@link publishServing} executes. */
  sql: string;
}

/**
 * Derive a publish's full plan without performing it. The pipeline runner calls this to show the
 * human the exact SQL and destination at the FR8 approval gate, and {@link publishServing} calls
 * it to execute — one derivation, so what is approved is precisely what runs.
 */
export function planPublishServing(input: PublishServingInput): PublishPlan {
  const table = safeTableName(input.table);
  const name = safeServedName(input.name ?? table);
  const format = input.format ?? DEFAULT_SERVING_FORMAT;
  const csvPath = join(input.servingDir, input.projectId, servedCsvFilename(name));
  return {
    name,
    table,
    qualifiedTable: `${MARTS_SCHEMA}.${table}`,
    format,
    csvPath,
    endpoint: servedEndpoint(name),
    csvEndpoint: servedCsvEndpoint(name),
    sql: buildCsvExportSql({ schema: MARTS_SCHEMA, table, csvPath }),
  };
}

/**
 * Publish `marts.<table>`: count it, export it to CSV, verify the export, and register it as the
 * table served at `name`. Returns the registered {@link ServedTable} — read back from the
 * registry, so it reflects what was actually persisted.
 *
 * The row count is read from the marts table (which fails honestly if the transform never
 * created it), and the written CSV is then read back and its row count compared: a mismatch
 * throws rather than registering an endpoint whose download disagrees with its data. The served
 * name and table are sanitized and the export SQL is built by the pure
 * {@link file://../core/serving.ts} — the same call the approval gate rendered.
 *
 * Throws when the format is unsupported, when `marts.<table>` does not exist, or when the export
 * cannot be written or does not round-trip — the caller (the T4.4 runner) maps those to a
 * run-step failure.
 */
export async function publishServing(
  store: WarehouseStore,
  input: PublishServingInput,
): Promise<ServedTable> {
  const format = input.format ?? DEFAULT_SERVING_FORMAT;
  if (!isServingFormat(format)) {
    throw new Error(`publish_serving: unsupported serving format "${format}"`);
  }

  const plan = planPublishServing({ ...input, format });

  // Count the source of truth first — this throws if the reviewed transform never materialized
  // the table, so a missing marts table fails the publish instead of serving an empty endpoint.
  const counted = await store.all(
    `SELECT count(*)::BIGINT AS row_count FROM ${MARTS_SCHEMA}."${plan.table.replace(/"/g, '""')}"`,
  );
  const rowCount = Number(counted[0]?.row_count ?? 0);

  // COPY does not create intermediate parent directories (as the land tool documents), so make
  // the project's export directory before writing into it.
  await mkdir(dirname(plan.csvPath), { recursive: true });

  // Generate the CSV export — the exact statement the human approved at the gate.
  await store.run(plan.sql);

  // Read the export back and compare: proves the file exists, parses, and carries every row.
  const exported = await store.all(
    `SELECT count(*)::BIGINT AS row_count FROM read_csv_auto(?)`,
    [plan.csvPath],
  );
  const exportedRows = Number(exported[0]?.row_count ?? 0);
  if (exportedRows !== rowCount) {
    throw new Error(
      `publish_serving: CSV export of ${plan.qualifiedTable} has ${exportedRows} rows, ` +
        `expected ${rowCount}`,
    );
  }

  // Register the endpoint last: nothing is served until its export is verified on disk.
  return await registerServedTable(store, {
    name: plan.name,
    projectId: input.projectId,
    runId: input.runId ?? null,
    table: plan.table,
    format: plan.format,
    rowCount,
    csvPath: plan.csvPath,
  });
}
