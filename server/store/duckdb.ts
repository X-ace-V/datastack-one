import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  DuckDBInstance,
  type DuckDBConnection,
  type DuckDBValue,
} from "@duckdb/node-api";

/**
 * DuckDB store primitive. The default file is the control-plane metadata store; the same
 * opener also creates each session's isolated execution catalog (with identical base schemas).
 * The `platform` metadata schema is available in both so existing tool/store contracts compose. It is
 * an I/O module by design (fs + DuckDB), so it lives under `server/store`, not
 * `server/core` (which stays pure). See ARCHITECTURE §3.4 and §9.
 */

/** Default on-disk warehouse. Overridable so tests can use `:memory:`. */
export const DEFAULT_DB_PATH = "data/warehouse.duckdb";

/**
 * The four warehouse schemas. `platform` holds our own metadata; `raw` →
 * `staging` → `marts` are the ELT layers the pipeline writes into. Order is the
 * creation order and does not otherwise matter.
 */
export const WAREHOUSE_SCHEMAS = [
  "platform",
  "raw",
  "staging",
  "marts",
] as const;

export type WarehouseSchema = (typeof WAREHOUSE_SCHEMAS)[number];

/**
 * The `platform` metadata tables, in dependency order (parents before children).
 * Kept as the source of truth so the migration and its test agree on the set.
 */
export const PLATFORM_TABLES = [
  "sessions",
  "messages",
  "lineage",
  "session_sources",
  "session_folders",
  "connections",
  "projects",
  "sources",
  "runs",
  "run_steps",
  "run_tool_calls",
  "artifacts",
  "dq_results",
  "approvals",
  "served_tables",
] as const;

export type PlatformTable = (typeof PLATFORM_TABLES)[number];

/**
 * Idempotent DDL for the metadata store. Table/schema creation is guarded by
 * `IF NOT EXISTS`; columns added after the original schema are handled by the
 * explicit, catalog-checked migrations below. Timestamps default to `now()` at
 * insert time; ids are supplied by the caller (application-generated) so this
 * schema has no engine-specific sequence coupling.
 */
const MIGRATION_STATEMENTS: readonly string[] = [
  ...WAREHOUSE_SCHEMAS.map((s) => `CREATE SCHEMA IF NOT EXISTS ${s};`),

  // FR1 — chat sessions (v2 agent model). Each row IS an embedded OpenCode session:
  // its id is the OpenCode session id, so the sidebar lists sessions and reopening one
  // restores its title/model. `title` is the human label; `model` is the per-session model
  // ref (NULL → the platform default applies). `updated_at` bumps on each new turn so the
  // sidebar can order by recent activity.
  `CREATE TABLE IF NOT EXISTS platform.sessions (
     id         VARCHAR PRIMARY KEY,
     title      VARCHAR NOT NULL,
     model      VARCHAR,
     created_at TIMESTAMP NOT NULL DEFAULT now(),
     updated_at TIMESTAMP NOT NULL DEFAULT now()
   );`,

  // FR1/FR2 — persisted chat history, one row per user/assistant message in a session.
  // `seq` orders the transcript monotonically within a session so reopening replays it in
  // order (wall-clock `created_at` can tie at sub-ms resolution). `role` is 'user' |
  // 'assistant'; `content` is the message text (for an assistant turn, its text blocks joined).
  // `blocks` holds the assistant turn's ordered rendered blocks (text/reasoning/tool cards) as
  // JSON so reopening a session reconstructs its tool-block history, not just the plain text
  // (V6.2, FR1) — NULL on a user message. The ask/answer + DQ audit still lives in `lineage`.
  `CREATE TABLE IF NOT EXISTS platform.messages (
     id         VARCHAR PRIMARY KEY,
     session_id VARCHAR NOT NULL,
     seq        BIGINT NOT NULL,
     role       VARCHAR NOT NULL,
     content    VARCHAR NOT NULL,
     blocks     VARCHAR,
     attachments VARCHAR,
     created_at TIMESTAMP NOT NULL DEFAULT now()
   );`,
  // FR9/FR10/FR12 — the conversational agent's per-session lineage/audit log. One append-only
  // row per auditable event the agent produced — a tool call, an approval decision, or a DQ
  // result — discriminated by `kind` ('tool_call' | 'approval' | 'dq_result'). `run_id` groups
  // the events of one build the agent orchestrated (NULL for ad-hoc events such as a bare
  // query); `seq` orders events within a session; `tool`/`status` are set for tool_call and
  // approval rows; `detail` carries the kind-specific JSON payload (args, exact SQL, check
  // outcome). This is the v2 replacement for the removed deterministic runner's split
  // run_tool_calls/dq_results/approvals — one session log the agent path (V4.4) writes.
  `CREATE TABLE IF NOT EXISTS platform.lineage (
     id         VARCHAR PRIMARY KEY,
     session_id VARCHAR NOT NULL,
     run_id     VARCHAR,
     seq        BIGINT NOT NULL,
     kind       VARCHAR NOT NULL,
     tool       VARCHAR,
     status     VARCHAR,
     detail     VARCHAR,
     created_at TIMESTAMP NOT NULL DEFAULT now()
   );`,

  // FR4 — the per-session data-source registry the agent tools read (V3.1). Distinct from
  // the project-scoped `platform.sources` (v1): a conversational session owns its own sources,
  // and the agent references each by `name` only — the raw `path` is resolved backend-side and
  // never handed to the model (FR5b). Keyed by (session_id, name) so a re-registration under
  // the same name in a session replaces the row (upsert). `row_count` is NULL until profiled.
  // The upload route (V3.2) writes here; `list_sources`/`profile_source` read here.
  `CREATE TABLE IF NOT EXISTS platform.session_sources (
     session_id VARCHAR NOT NULL,
     name       VARCHAR NOT NULL,
     kind       VARCHAR NOT NULL DEFAULT 'csv',
     path       VARCHAR NOT NULL,
     origin     VARCHAR NOT NULL DEFAULT 'upload',
     relative_path VARCHAR,
     row_count  BIGINT,
     created_at TIMESTAMP NOT NULL DEFAULT now(),
     PRIMARY KEY (session_id, name)
   );`,
  // One primary local workspace folder per chat session. The absolute path is control-plane
  // metadata used only by the local backend; model-facing tools receive relative paths.
  `CREATE TABLE IF NOT EXISTS platform.session_folders (
     session_id   VARCHAR PRIMARY KEY,
     name         VARCHAR NOT NULL,
     path         VARCHAR NOT NULL,
     workspace_root BOOLEAN NOT NULL DEFAULT false,
     connected_at TIMESTAMP NOT NULL DEFAULT now()
   );`,
  // FR5 — registered database connections (Settings → Connections). One row per named Postgres
  // (Neon) connection the user added. Keyed by `name` (a registry, not a log): the name is the
  // agent-facing handle and the future `ATTACH … AS <name>` alias, so exactly one URL answers a
  // name and re-adding a name replaces the row. `url` is the SECRET — it lives ONLY in this
  // gitignored warehouse file, is bound in as a parameter, and is never selected into any API
  // response (reads that feed the client omit it); the backend resolves name → url only to test
  // or ATTACH the database (FR5b). See ARCHITECTURE §3.7.
  `CREATE TABLE IF NOT EXISTS platform.connections (
     name       VARCHAR PRIMARY KEY,
     type       VARCHAR NOT NULL DEFAULT 'postgres',
     url        VARCHAR NOT NULL,
     created_at TIMESTAMP NOT NULL DEFAULT now()
   );`,

  // FR1 — projects created by the wizard's first step.
  `CREATE TABLE IF NOT EXISTS platform.projects (
     id              VARCHAR PRIMARY KEY,
     name            VARCHAR NOT NULL,
     domain          VARCHAR NOT NULL,
     expected_volume VARCHAR,
     warehouse       VARCHAR NOT NULL DEFAULT 'duckdb',
     serving_style   VARCHAR,
     created_at      TIMESTAMP NOT NULL DEFAULT now()
   );`,

  // FR2 — uploaded CSV sources, one or more per project.
  `CREATE TABLE IF NOT EXISTS platform.sources (
     id                VARCHAR PRIMARY KEY,
     project_id        VARCHAR NOT NULL,
     kind              VARCHAR NOT NULL DEFAULT 'csv',
     path              VARCHAR NOT NULL,
     original_filename VARCHAR,
     row_count         BIGINT,
     created_at        TIMESTAMP NOT NULL DEFAULT now()
   );`,

  // FR9/FR12 — a pipeline run and its per-stage steps.
  `CREATE TABLE IF NOT EXISTS platform.runs (
     id         VARCHAR PRIMARY KEY,
     project_id VARCHAR NOT NULL,
     status     VARCHAR NOT NULL DEFAULT 'pending',
     model      VARCHAR,
     created_at TIMESTAMP NOT NULL DEFAULT now(),
     updated_at TIMESTAMP NOT NULL DEFAULT now()
   );`,
  `CREATE TABLE IF NOT EXISTS platform.run_steps (
     id          VARCHAR PRIMARY KEY,
     run_id      VARCHAR NOT NULL,
     name        VARCHAR NOT NULL,
     ordinal     INTEGER NOT NULL,
     status      VARCHAR NOT NULL DEFAULT 'pending',
     detail      VARCHAR,
     started_at  TIMESTAMP,
     finished_at TIMESTAMP
   );`,

  // FR12 — the tool calls a run executed, one row per tool the runner invoked. `run_steps` records
  // the six visible stages; this records what actually ran inside them (tool, args, outcome), which
  // is a strict subset: a stage with no tool (Extract) contributes none. `status` starts 'running'
  // and is written before the tool executes, so a call that dies mid-flight still leaves a trace.
  `CREATE TABLE IF NOT EXISTS platform.run_tool_calls (
     id          VARCHAR PRIMARY KEY,
     run_id      VARCHAR NOT NULL,
     step_id     VARCHAR NOT NULL,
     tool        VARCHAR NOT NULL,
     args        VARCHAR,
     status      VARCHAR NOT NULL DEFAULT 'running',
     result      VARCHAR,
     error       VARCHAR,
     started_at  TIMESTAMP NOT NULL DEFAULT now(),
     finished_at TIMESTAMP
   );`,

  // FR3/FR6/FR7 — generated artifacts (plan, SQL, DDL, DQ spec, serving spec).
  `CREATE TABLE IF NOT EXISTS platform.artifacts (
     id         VARCHAR PRIMARY KEY,
     project_id VARCHAR NOT NULL,
     run_id     VARCHAR,
     kind       VARCHAR NOT NULL,
     path       VARCHAR,
     content    VARCHAR,
     created_at TIMESTAMP NOT NULL DEFAULT now()
   );`,

  // FR7 — data-quality check outcomes; a failure blocks publish.
  `CREATE TABLE IF NOT EXISTS platform.dq_results (
     id         VARCHAR PRIMARY KEY,
     run_id     VARCHAR NOT NULL,
     check_name VARCHAR NOT NULL,
     passed     BOOLEAN NOT NULL,
     detail     VARCHAR,
     created_at TIMESTAMP NOT NULL DEFAULT now()
   );`,

  // FR8/FR12 — the approval audit trail: one row per permission asked/answered.
  `CREATE TABLE IF NOT EXISTS platform.approvals (
     id         VARCHAR PRIMARY KEY,
     run_id     VARCHAR,
     request_id VARCHAR NOT NULL,
     tool       VARCHAR NOT NULL,
     args       VARCHAR,
     action     VARCHAR NOT NULL DEFAULT 'pending',
     created_at TIMESTAMP NOT NULL DEFAULT now(),
     decided_at TIMESTAMP
   );`,

  // FR10 — the served-table registry the publish stage writes and the generated
  // `/api/serve/:name` endpoints read. Unlike the log tables above this is a registry keyed by
  // the served `name`: that name is the endpoint's URL segment, so exactly one table may answer
  // it and re-publishing a name replaces the row rather than appending a second claim on the
  // same URL. The run/approval history of each publish lives in `runs`/`approvals` (FR12).
  `CREATE TABLE IF NOT EXISTS platform.served_tables (
     name         VARCHAR PRIMARY KEY,
     project_id   VARCHAR NOT NULL,
     run_id       VARCHAR,
     schema_name  VARCHAR NOT NULL,
     table_name   VARCHAR NOT NULL,
     format       VARCHAR NOT NULL DEFAULT 'csv',
     row_count    BIGINT NOT NULL,
     csv_path     VARCHAR NOT NULL,
     published_at TIMESTAMP NOT NULL DEFAULT now()
   );`,
];

/**
 * Columns introduced after the first on-disk schema shipped. DuckDB 1.5.x can
 * write a redundant `ALTER TABLE ... ADD COLUMN IF NOT EXISTS ... DEFAULT ...`
 * into the WAL and then fail internally while replaying it after an unclean
 * shutdown. Querying the catalog first means an already-migrated database does
 * not execute (or log) an ALTER on every boot. Defaults are backfilled with a
 * separate UPDATE; all application writes supply `origin`/`workspace_root`
 * explicitly, while fresh databases retain their NOT NULL defaults above.
 */
const COLUMN_MIGRATIONS = [
  {
    schema: "platform",
    table: "messages",
    column: "blocks",
    definition: "VARCHAR",
  },
  {
    schema: "platform",
    table: "messages",
    column: "attachments",
    definition: "VARCHAR",
  },
  {
    schema: "platform",
    table: "session_sources",
    column: "origin",
    definition: "VARCHAR",
    backfill: "'upload'",
  },
  {
    schema: "platform",
    table: "session_sources",
    column: "relative_path",
    definition: "VARCHAR",
  },
  {
    schema: "platform",
    table: "session_folders",
    column: "workspace_root",
    definition: "BOOLEAN",
    backfill: "false",
  },
] as const;

/** A thin, awaitable handle over one DuckDB connection to the warehouse file. */
export interface WarehouseStore {
  /** The underlying connection, for tools/routes that need raw access. */
  readonly connection: DuckDBConnection;
  /** The path this store was opened at (`:memory:` in tests). */
  readonly path: string;
  /**
   * Execute a statement that returns no rows the caller needs. Optional positional
   * `values` bind to `$1`, `$2`, … placeholders so callers never string-concatenate
   * user input into SQL (the only injection-safe way to persist request bodies).
   */
  run(sql: string, values?: DuckDBValue[]): Promise<void>;
  /** Execute a query and materialize its rows as plain objects, with the same binding. */
  all(sql: string, values?: DuckDBValue[]): Promise<Record<string, unknown>[]>;
  /** Close the connection and its owning instance. */
  close(): Promise<void>;
}

/**
 * Run every migration statement in order. Safe to call repeatedly — all DDL is
 * `IF NOT EXISTS`, so a second call is a no-op and never errors.
 */
export async function migrate(store: WarehouseStore): Promise<void> {
  for (const statement of MIGRATION_STATEMENTS) {
    await store.run(statement);
  }

  for (const migration of COLUMN_MIGRATIONS) {
    const rows = await store.all(
      `SELECT 1 AS present
       FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
      [migration.schema, migration.table, migration.column],
    );
    if (rows.length === 0) {
      await store.run(
        `ALTER TABLE ${migration.schema}.${migration.table}
         ADD COLUMN ${migration.column} ${migration.definition}`,
      );
    }
    if ("backfill" in migration) {
      await store.run(
        `UPDATE ${migration.schema}.${migration.table}
         SET ${migration.column} = ${migration.backfill}
         WHERE ${migration.column} IS NULL`,
      );
    }
  }
}

/**
 * Open (creating if absent) the warehouse at `path`, then migrate it so the
 * `platform` schema and its tables are guaranteed to exist before any caller
 * touches them. Ensures the parent directory exists for on-disk paths.
 */
export async function openStore(
  path: string = DEFAULT_DB_PATH,
): Promise<WarehouseStore> {
  if (path !== ":memory:") {
    await mkdir(dirname(path), { recursive: true });
  }

  const instance = await DuckDBInstance.create(path);
  const connection = await instance.connect();

  const store: WarehouseStore = {
    connection,
    path,
    async run(sql: string, values?: DuckDBValue[]): Promise<void> {
      await connection.run(sql, values);
    },
    async all(
      sql: string,
      values?: DuckDBValue[],
    ): Promise<Record<string, unknown>[]> {
      const reader = await connection.runAndReadAll(sql, values);
      return reader.getRowObjects();
    },
    async close(): Promise<void> {
      connection.disconnectSync();
      instance.closeSync();
    },
  };

  await migrate(store);
  // Consolidate schema changes immediately. If the process is interrupted later,
  // its WAL contains only application transactions, not catalog ALTER records that
  // DuckDB 1.5.x may be unable to replay after a crash.
  if (path !== ":memory:") {
    await store.run("CHECKPOINT;");
  }
  return store;
}
