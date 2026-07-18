import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin/tool";

/**
 * The single `@opencode-ai/plugin` that exposes DataStack One's data-engineering tools to the
 * agent (PRD FR4/FR6, ARCHITECTURE §3.4). OpenCode loads this file by URL into its OWN runtime
 * — a separate process from the Fastify backend — so it must be self-contained: it imports only
 * `@opencode-ai/plugin` and `zod` (both resolved from the project's `node_modules`), never this
 * repo's store/core modules. It cannot touch DuckDB directly; instead each tool `execute()`
 * calls back to the backend over loopback (`/api/internal/tools/*`), which owns the store. This
 * mirrors the Crux "internal.ts" loopback pattern the ARCHITECTURE cites.
 *
 * Read tools (`list_sources`, `profile_source`, `run_query`) execute immediately; the write tools
 * (`land_parquet`, `load_warehouse`, `run_transform`, `publish_serving`) are approval-gated
 * (V4.1, FR8/FR10). OpenCode does NOT gate a custom plugin tool — a plugin's `context.ask(...)`
 * auto-resolves in the embedded runtime (verified live) — so the pause is enforced BACKEND-side:
 * a write tool's loopback route blocks on a human approval before it executes, and returns
 * `{ approved: false }` if rejected. This plugin just calls that route and turns a rejection into
 * a "denied, nothing written" message. The agent addresses a source by its `name`; the raw path
 * is resolved backend-side and never crosses this boundary (FR5b).
 */

// zod, re-exported by the plugin SDK so the plugin and its host agree on one zod instance.
const z = tool.schema;

/** How long a normal (read) loopback call may run before the tool reports a clear failure. */
const INTERNAL_CALL_TIMEOUT_MS = 30_000;

/**
 * Write tools call a loopback route that BLOCKS on a human approval (V4.1), so they need a far
 * longer ceiling than a read — a person may take minutes to review the SQL. This bounds a truly
 * stuck request without cutting off a human who is still deciding.
 */
const WRITE_CALL_TIMEOUT_MS = 10 * 60_000;

/**
 * Base URL of the Fastify backend to call back into. Set in the parent process before the
 * OpenCode server is spawned (see `server/index.ts`), so this subprocess inherits it in its
 * environment. Falls back to the default local port when unset (e.g. an ad-hoc boot).
 */
function backendBaseUrl(): string {
  return process.env.DATASTACK_INTERNAL_URL ?? "http://127.0.0.1:3001";
}

/** POST a JSON body to a backend loopback route and return the parsed envelope. */
async function callBackend(
  path: string,
  body: Record<string, unknown>,
  timeoutMs: number = INTERNAL_CALL_TIMEOUT_MS,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${backendBaseUrl()}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch {
      /* non-JSON / empty body */
    }
    return { ok: res.ok, status: res.status, body: parsed };
  } finally {
    clearTimeout(timer);
  }
}

/** A model-safe source view as returned by `list_sources`. */
interface ListedSource {
  name: string;
  kind: string;
  rowCount: number | null;
}

/** A column of a source profile as returned by `profile_source`. */
interface ColumnProfile {
  name: string;
  type: string;
  nullPercent: number;
  distinctCount: number;
  isCandidateKey: boolean;
  isDateColumn: boolean;
}

/** The profile payload `profile_source` returns for one source. */
interface SourceProfile {
  rowCount: number;
  columns: ColumnProfile[];
  candidateKeys: string[];
  dateColumns: string[];
}

/** A column of a `run_query` result. */
interface QueryColumn {
  name: string;
  type: string;
}

/** The result payload `run_query` returns: columns, rows, and a truncation flag. */
interface QueryResult {
  columns: QueryColumn[];
  rows: Record<string, string | number | boolean | null>[];
  rowCount: number;
  truncated: boolean;
}

/** How many result rows to spell out in the model-facing text before summarizing the rest. */
const QUERY_PREVIEW_ROWS = 20;

/** Render a query result as a compact, model-readable table (the panel gets the full result). */
function formatQueryResult(result: QueryResult): string {
  const header = result.columns.map((c) => c.name).join(" | ");
  const preview = result.rows.slice(0, QUERY_PREVIEW_ROWS).map((row) =>
    result.columns
      .map((c) => {
        const cell = row[c.name];
        return cell === null || cell === undefined ? "NULL" : String(cell);
      })
      .join(" | "),
  );
  const lines = [
    `${result.rowCount} row${result.rowCount === 1 ? "" : "s"}` +
      `${result.truncated ? ` (showing the first ${result.rowCount})` : ""}, ` +
      `${result.columns.length} column${result.columns.length === 1 ? "" : "s"}.`,
    "",
    header,
    ...preview,
  ];
  if (result.rows.length > QUERY_PREVIEW_ROWS) {
    lines.push(`… and ${result.rows.length - QUERY_PREVIEW_ROWS} more row(s).`);
  }
  return lines.join("\n");
}

/** Render a profile as a compact, model-readable summary. */
function formatProfile(source: string, profile: SourceProfile): string {
  const lines = [
    `Source "${source}": ${profile.rowCount} rows, ${profile.columns.length} columns.`,
    "",
    "Columns:",
    ...profile.columns.map(
      (c) =>
        `  - ${c.name} (${c.type}) — ${c.nullPercent}% null, ${c.distinctCount} distinct` +
        `${c.isCandidateKey ? ", candidate key" : ""}${c.isDateColumn ? ", date" : ""}`,
    ),
  ];
  const keys = profile.candidateKeys.length > 0 ? profile.candidateKeys.join(", ") : "none";
  const dates = profile.dateColumns.length > 0 ? profile.dateColumns.join(", ") : "none";
  lines.push("", `Candidate keys: ${keys}`, `Date columns: ${dates}`);
  return lines.join("\n");
}

/** One executed data-quality check's outcome, as `run_dq_check` returns it. */
interface DqCheckResult {
  name: string;
  type: string;
  column: string | null;
  passed: boolean;
  detail: string;
}

/** The result of a whole `run_dq_check` run: per-check outcomes + the aggregate publish gate. */
interface DqRunResult {
  targetTable: string;
  results: DqCheckResult[];
  passed: boolean;
}

/** Render a DQ run as a compact, model-readable pass/fail report. */
function formatDqResult(result: DqRunResult): string {
  const passedCount = result.results.filter((r) => r.passed).length;
  const lines = [
    `${result.passed ? "PASSED" : "FAILED"} — ${passedCount}/${result.results.length} ` +
      `check${result.results.length === 1 ? "" : "s"} passed on ${result.targetTable}.`,
    "",
    ...result.results.map(
      (r) =>
        `  ${r.passed ? "✓" : "✗"} ${r.name} (${r.type}${r.column ? ` on ${r.column}` : ""}) — ${r.detail}`,
    ),
  ];
  if (!result.passed) {
    lines.push(
      "",
      "One or more checks failed, so publish_serving is BLOCKED for this session until a later " +
        "run passes. Fix the data (or the checks) and re-run run_dq_check.",
    );
  }
  return lines.join("\n");
}

/** What `land_parquet` returns once a landed dataset persists. */
interface LandResult {
  dataset: string;
  ingestionDate: string;
  rowCount: number;
}

/** What `load_warehouse` returns once a warehouse table is materialized. */
interface LoadResult {
  qualifiedTable: string;
  schema: string;
  table: string;
  rowCount: number;
}

/** What `run_transform` returns once the reviewed SQL materializes a marts table. */
interface TransformResult {
  qualifiedTable: string;
  table: string;
  rowCount: number;
}

/** What `publish_serving` returns once a marts table is exported and registered. */
interface PublishResult {
  name: string;
  endpoint: string;
  csvEndpoint: string;
  rowCount: number;
}

/** One column of an attached connection's table, as `attach_source` returns it. */
interface AttachedColumn {
  name: string;
  type: string;
}

/** One table an attached connection exposes read-only: schema, name, and columns. */
interface AttachedTable {
  schema: string;
  table: string;
  columns: AttachedColumn[];
}

/** What `attach_source` returns once a registered connection is attached read-only. */
interface AttachSourceResult {
  name: string;
  tables: AttachedTable[];
}

/** Render an attach result as a compact, model-readable schema summary (never a URL). */
function formatAttachResult(result: AttachSourceResult): string {
  if (result.tables.length === 0) {
    return (
      `Attached connection "${result.name}" read-only, but it exposes no tables. ` +
      "Check the database has tables the connection can read."
    );
  }
  const lines = [
    `Attached connection "${result.name}" read-only — ${result.tables.length} ` +
      `table${result.tables.length === 1 ? "" : "s"}. ` +
      `Query them as ${result.name}.<schema>.<table> with run_query.`,
    "",
    ...result.tables.map(
      (t) =>
        `  - ${result.name}.${t.schema}.${t.table} (${t.columns.length} col` +
        `${t.columns.length === 1 ? "" : "s"}): ` +
        t.columns.map((c) => `${c.name} ${c.type}`).join(", "),
    ),
  ];
  return lines.join("\n");
}

/**
 * The message a write tool returns to the model when the human denied its approval.
 * `body.approved === false` from a write route means the human rejected the inline approval.
 */
function deniedMessage(tool: string): string {
  return `${tool} was not run: the approval was denied, so nothing was written.`;
}

/**
 * Call a write route, which BLOCKS on a human approval before it executes (V4.1). Returns
 * `{ denied: true }` when the human rejected the inline approval (`body.approved === false`),
 * otherwise the route's envelope. The long write timeout covers a human still deciding.
 */
async function callWriteRoute(
  path: string,
  body: Record<string, unknown>,
): Promise<{ denied: boolean; ok: boolean; status: number; body: unknown }> {
  const { ok, status, body: resBody } = await callBackend(path, body, WRITE_CALL_TIMEOUT_MS);
  const denied = ok && (resBody as { approved?: boolean })?.approved === false;
  return { denied, ok, status, body: resBody };
}

export const DatastackToolsPlugin: Plugin = async () => {
  return {
    tool: {
      list_sources: tool({
        description:
          "List the data sources connected to the current session (CSV uploads and, later, " +
          "registered databases) by name, kind, and row count. Call this first to see what " +
          "data is available before profiling or querying. Read-only; needs no approval.",
        args: {},
        async execute(_args, context) {
          const { ok, status, body } = await callBackend(
            "/api/internal/tools/list_sources",
            { sessionID: context.sessionID },
          );
          if (!ok) {
            return `Failed to list sources (status ${status}).`;
          }
          const sources = ((body as { sources?: ListedSource[] })?.sources ?? []);
          if (sources.length === 0) {
            return "No data sources are connected to this session yet. Upload a CSV to add one.";
          }
          const output = sources
            .map(
              (s) =>
                `- ${s.name} (${s.kind})${s.rowCount == null ? "" : ` — ${s.rowCount} rows`}`,
            )
            .join("\n");
          return {
            title: `${sources.length} source${sources.length === 1 ? "" : "s"}`,
            output,
            metadata: { sources },
          };
        },
      }),

      profile_source: tool({
        description:
          "Profile a connected source by name: schema, column types, row count, null %, " +
          "candidate primary keys, and date columns. Use the exact name from list_sources. " +
          "Read-only; needs no approval.",
        args: {
          source: z
            .string()
            .describe("The name of the connected source to profile (from list_sources)."),
        },
        async execute(args, context) {
          const { ok, status, body } = await callBackend(
            "/api/internal/tools/profile_source",
            { sessionID: context.sessionID, source: args.source },
          );
          if (status === 404) {
            return (
              `No source named "${args.source}" is connected to this session. ` +
              "Call list_sources to see the connected sources."
            );
          }
          if (status === 422) {
            return `Source "${args.source}" could not be read or profiled (it may not be valid CSV).`;
          }
          if (!ok) {
            return `Failed to profile "${args.source}" (status ${status}).`;
          }
          const payload = body as { source: string; profile: SourceProfile };
          return {
            title: `Profiled ${payload.source}`,
            output: formatProfile(payload.source, payload.profile),
            metadata: { profile: payload.profile },
          };
        },
      }),

      run_query: tool({
        description:
          "Run a read-only SQL SELECT over the connected data and return the rows. Reference a " +
          "source by the exact name from list_sources (e.g. `SELECT * FROM loans LIMIT 10`); the " +
          "warehouse's raw/staging/marts tables are queryable by their qualified names too. Only " +
          "a single SELECT is allowed — no INSERT/UPDATE/CREATE/etc. Use this to answer questions " +
          "about the data. Read-only; needs no approval.",
        args: {
          sql: z
            .string()
            .describe("A single read-only SQL SELECT statement to run over the connected sources."),
        },
        async execute(args, context) {
          const { ok, status, body } = await callBackend(
            "/api/internal/tools/run_query",
            { sessionID: context.sessionID, sql: args.sql },
          );
          if (status === 422) {
            const detail = (body as { error?: string })?.error ?? "the query could not be run";
            return `Query failed: ${detail}. Check the SQL and the source names from list_sources.`;
          }
          if (!ok) {
            return `Failed to run the query (status ${status}).`;
          }
          const result = (body as { result?: QueryResult })?.result;
          if (!result) {
            return "The query returned no result.";
          }
          return {
            title: `${result.rowCount} row${result.rowCount === 1 ? "" : "s"}`,
            output: formatQueryResult(result),
            metadata: { result },
          };
        },
      }),

      run_dq_check: tool({
        description:
          "Run data-quality checks over a loaded warehouse table (default raw.source) and report " +
          "pass/fail per check. Provide AT LEAST 3 checks covering at least 3 of the four types: " +
          "row_count (table has rows; column=null), not_null (a key column has no NULLs), schema " +
          "(a column is present), freshness (a date column is non-null). Read-only; needs no " +
          "approval. IMPORTANT: if any check FAILS, publish_serving is blocked for this session " +
          "until a later run passes — run this before publishing.",
        args: {
          targetTable: z
            .string()
            .optional()
            .describe("The loaded table to check. Defaults to raw.source (the loaded source)."),
          checks: z
            .array(
              z.object({
                name: z.string().describe("Short check name, e.g. 'loan_id not null'."),
                type: z
                  .enum(["row_count", "not_null", "schema", "freshness"])
                  .describe("Which kind of assertion this check makes."),
                column: z
                  .string()
                  .nullable()
                  .describe("The column checked; null for a table-level row_count check."),
                description: z
                  .string()
                  .describe("Plain-English statement of what the check asserts."),
              }),
            )
            .describe("At least 3 checks, covering at least 3 of the four types."),
        },
        async execute(args, context) {
          const { ok, status, body } = await callBackend("/api/internal/tools/run_dq_check", {
            sessionID: context.sessionID,
            ...(args.targetTable ? { targetTable: args.targetTable } : {}),
            checks: args.checks,
          });
          if (status === 422) {
            const detail = (body as { error?: string })?.error ?? "the checks were invalid";
            return `run_dq_check failed: ${detail}. Provide ≥3 checks covering ≥3 of the four types.`;
          }
          if (!ok) {
            return `Failed to run data-quality checks (status ${status}).`;
          }
          const result = (body as { result?: DqRunResult })?.result;
          if (!result) {
            return "The data-quality run returned no result.";
          }
          return {
            title: result.passed
              ? `DQ passed (${result.results.length} checks)`
              : "DQ failed — publish blocked",
            output: formatDqResult(result),
            metadata: { dq: result },
          };
        },
      }),

      land_parquet: tool({
        description:
          "Land a connected source to Parquet in the data lake, partitioned by ingestion date. " +
          "Pass the exact source name from list_sources. This WRITES data, so it pauses for your " +
          "explicit approval before it runs. Do this first when building a pipeline from a source.",
        args: {
          source: z
            .string()
            .describe("The connected source to land (the exact name from list_sources)."),
          ingestionDate: z
            .string()
            .optional()
            .describe("Ingestion date to partition under, YYYY-MM-DD. Defaults to today."),
        },
        async execute(args, context) {
          const { denied, ok, status, body } = await callWriteRoute(
            "/api/internal/tools/land_parquet",
            {
              sessionID: context.sessionID,
              source: args.source,
              ...(args.ingestionDate ? { ingestionDate: args.ingestionDate } : {}),
            },
          );
          if (denied) return deniedMessage("land_parquet");
          if (status === 404) {
            return (
              `No source named "${args.source}" is connected to this session. ` +
              "Call list_sources to see the connected sources."
            );
          }
          if (status === 422) {
            const detail = (body as { error?: string })?.error ?? "the source could not be landed";
            return `land_parquet failed: ${detail}.`;
          }
          if (!ok) return `Failed to land "${args.source}" (status ${status}).`;
          const result = body as LandResult;
          return {
            title: `Landed ${result.dataset}`,
            output:
              `Landed source "${args.source}" as dataset "${result.dataset}" ` +
              `(${result.rowCount} rows, ingestion_date=${result.ingestionDate}). ` +
              `Next, load it with load_warehouse using dataset="${result.dataset}".`,
            metadata: { land: result },
          };
        },
      }),

      load_warehouse: tool({
        description:
          "Load a previously landed dataset into the warehouse (raw/staging schema). Pass the " +
          "dataset name returned by land_parquet. Defaults to raw.source, the table transforms " +
          "read from. This WRITES data, so it pauses for your explicit approval before it runs.",
        args: {
          dataset: z
            .string()
            .describe("The landed dataset name to load (returned by land_parquet)."),
          schema: z
            .string()
            .optional()
            .describe("Target schema: raw (default) or staging."),
          table: z
            .string()
            .optional()
            .describe("Target table name. Defaults to source (i.e. raw.source)."),
        },
        async execute(args, context) {
          const { denied, ok, status, body } = await callWriteRoute(
            "/api/internal/tools/load_warehouse",
            {
              sessionID: context.sessionID,
              dataset: args.dataset,
              ...(args.schema ? { schema: args.schema } : {}),
              ...(args.table ? { table: args.table } : {}),
            },
          );
          if (denied) return deniedMessage("load_warehouse");
          if (status === 422) {
            const detail = (body as { error?: string })?.error ?? "the dataset could not be loaded";
            return `load_warehouse failed: ${detail}. Make sure the dataset was landed first.`;
          }
          if (!ok) return `Failed to load dataset "${args.dataset}" (status ${status}).`;
          const result = body as LoadResult;
          return {
            title: `Loaded ${result.qualifiedTable}`,
            output:
              `Loaded dataset "${args.dataset}" into ${result.qualifiedTable} ` +
              `(${result.rowCount} rows).`,
            metadata: { load: result },
          };
        },
      }),

      run_transform: tool({
        description:
          "Execute transformation SQL to build a marts table. Provide the full SQL (a " +
          "CREATE OR REPLACE TABLE marts.<target> AS SELECT ... statement) and the target table " +
          "name. This WRITES data and runs your exact SQL, so it pauses for your explicit approval " +
          "— the exact SQL is shown for review — before it runs.",
        args: {
          sql: z
            .string()
            .describe("The full transform SQL to execute (CREATE OR REPLACE TABLE marts.<target> AS …)."),
          targetTable: z
            .string()
            .describe("The unqualified marts table the SQL creates (e.g. daily_branch_summary)."),
        },
        async execute(args, context) {
          const { denied, ok, status, body } = await callWriteRoute(
            "/api/internal/tools/run_transform",
            {
              sessionID: context.sessionID,
              sql: args.sql,
              targetTable: args.targetTable,
            },
          );
          if (denied) return deniedMessage("run_transform");
          if (status === 422) {
            const detail = (body as { error?: string })?.error ?? "the transform could not be run";
            return `run_transform failed: ${detail}. Check the SQL and the source tables it reads.`;
          }
          if (!ok) return `Failed to run the transform (status ${status}).`;
          const result = body as TransformResult;
          return {
            title: `Built ${result.qualifiedTable}`,
            output:
              `Executed the transform into ${result.qualifiedTable} (${result.rowCount} rows).`,
            metadata: { transform: result },
          };
        },
      }),

      publish_serving: tool({
        description:
          "Publish a marts table as a REST endpoint plus a CSV export. Pass the marts table name " +
          "(and optionally a served name for the URL). This WRITES an export and registers a public " +
          "endpoint, so it pauses for your explicit approval before it runs.",
        args: {
          table: z
            .string()
            .describe("The unqualified marts table to publish (e.g. daily_branch_summary)."),
          name: z
            .string()
            .optional()
            .describe("Served name / URL segment. Defaults to the table name."),
        },
        async execute(args, context) {
          const { denied, ok, status, body } = await callWriteRoute(
            "/api/internal/tools/publish_serving",
            {
              sessionID: context.sessionID,
              table: args.table,
              ...(args.name ? { name: args.name } : {}),
            },
          );
          if (denied) return deniedMessage("publish_serving");
          if (status === 409) {
            const failed = (body as { failedChecks?: string[] })?.failedChecks ?? [];
            const which = failed.length > 0 ? ` (${failed.join(", ")})` : "";
            return (
              `publish_serving was blocked: the most recent data-quality checks failed${which}. ` +
              "Fix the data and re-run run_dq_check until all checks pass before publishing."
            );
          }
          if (status === 422) {
            const detail = (body as { error?: string })?.error ?? "the table could not be published";
            return `publish_serving failed: ${detail}. Make sure the marts table exists.`;
          }
          if (!ok) return `Failed to publish "${args.table}" (status ${status}).`;
          const result = body as PublishResult;
          return {
            title: `Published ${result.name}`,
            output:
              `Published marts.${args.table} as "${result.name}" (${result.rowCount} rows). ` +
              `REST: ${result.endpoint} · CSV: ${result.csvEndpoint}.`,
            metadata: { publish: result },
          };
        },
      }),

      attach_source: tool({
        description:
          "Attach a registered database connection (added in Settings → Connections) to this " +
          "session, read-only, so its live tables become queryable by name alongside CSVs. Pass " +
          "the connection NAME only — never a URL; credentials live only in Settings and never " +
          "reach you. This connects a live database, so it pauses for your explicit approval " +
          "before it runs. After attaching, query its tables as <name>.<schema>.<table> with " +
          "run_query (you can join them to a CSV).",
        args: {
          name: z
            .string()
            .describe("The registered connection name to attach (from Settings → Connections)."),
        },
        async execute(args, context) {
          const { denied, ok, status, body } = await callWriteRoute(
            "/api/internal/tools/attach_source",
            { sessionID: context.sessionID, name: args.name },
          );
          if (denied) return deniedMessage("attach_source");
          if (status === 404) {
            return (
              `No connection named "${args.name}" is registered. ` +
              "Ask the user to add it in Settings → Connections first."
            );
          }
          if (status === 422) {
            const detail =
              (body as { error?: string })?.error ?? "the connection could not be attached";
            return `attach_source failed: ${detail}.`;
          }
          if (!ok) return `Failed to attach "${args.name}" (status ${status}).`;
          const result = body as AttachSourceResult;
          return {
            title: `Attached ${result.name}`,
            output: formatAttachResult(result),
            metadata: { attach: result },
          };
        },
      }),
    },
  };
};

export default DatastackToolsPlugin;
