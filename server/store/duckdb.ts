import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";

/**
 * DuckDB metadata store. This module owns the single warehouse file and the
 * `platform` metadata schema every other backend module reads and writes. It is
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
  "projects",
  "sources",
  "runs",
  "run_steps",
  "artifacts",
  "dq_results",
  "approvals",
] as const;

export type PlatformTable = (typeof PLATFORM_TABLES)[number];

/**
 * Idempotent DDL for the metadata store. Every statement is `IF NOT EXISTS` so
 * migrating an already-migrated database is a no-op — the migration can run on
 * every boot. Timestamps default to `now()` at insert time; ids are supplied by
 * the caller (application-generated) so this schema has no engine-specific
 * sequence coupling.
 */
const MIGRATION_STATEMENTS: readonly string[] = [
  ...WAREHOUSE_SCHEMAS.map((s) => `CREATE SCHEMA IF NOT EXISTS ${s};`),

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
];

/** A thin, awaitable handle over one DuckDB connection to the warehouse file. */
export interface WarehouseStore {
  /** The underlying connection, for tools/routes that need raw access. */
  readonly connection: DuckDBConnection;
  /** The path this store was opened at (`:memory:` in tests). */
  readonly path: string;
  /** Execute a statement that returns no rows the caller needs. */
  run(sql: string): Promise<void>;
  /** Execute a query and materialize its rows as plain objects. */
  all(sql: string): Promise<Record<string, unknown>[]>;
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
    async run(sql: string): Promise<void> {
      await connection.run(sql);
    },
    async all(sql: string): Promise<Record<string, unknown>[]> {
      const reader = await connection.runAndReadAll(sql);
      return reader.getRowObjects();
    },
    async close(): Promise<void> {
      connection.disconnectSync();
      instance.closeSync();
    },
  };

  await migrate(store);
  return store;
}
