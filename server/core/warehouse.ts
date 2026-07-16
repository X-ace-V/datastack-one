import { z } from "zod";

/**
 * Pure warehouse-load contract (PRD FR5). The "Load Warehouse" pipeline stage reads the Parquet
 * the land step wrote (`data/landing/<dataset>/ingestion_date=.../*.parquet`) and materializes it
 * as a DuckDB table in the `raw` (or `staging`) schema — the seam the transform stage reads from
 * (`FROM raw.source`, see {@link file://./transform.ts}) and the DQ stage checks
 * (`DQ_TARGET_TABLE = raw.source`, {@link file://./dq.ts}).
 *
 * This module stays pure — no fs/net/process — so the schema/table validators and the result
 * shape can be reused by the `load_warehouse` tool ({@link file://../tools/warehouse.ts}), the
 * pipeline runner (T4.4) and the UI, and unit-tested in isolation. The DuckDB `CREATE TABLE ...
 * AS SELECT` that does the load lives in the tool, never here.
 */

/**
 * The schemas `load_warehouse` may target (PRD FR5: "a DuckDB `raw`/`staging` table"). `marts`
 * is deliberately excluded — it is the transform stage's output, written by `run_transform`, not
 * a raw load target. Kept as a closed set so an arbitrary schema name can never reach the DDL.
 */
export const LOAD_SCHEMAS = ["raw", "staging"] as const;

export type LoadSchema = (typeof LOAD_SCHEMAS)[number];

/**
 * The default load target. Landed source data loads into `raw.source` — the exact table the
 * transform stage's generated SQL selects from and the DQ stage checks — so the pipeline's
 * stages line up without the model having to guess a table name.
 */
export const DEFAULT_LOAD_SCHEMA: LoadSchema = "raw";
export const DEFAULT_LOAD_TABLE = "source";

/** Fallback table name when a caller-supplied name sanitizes to nothing. */
const DEFAULT_TABLE_FALLBACK = DEFAULT_LOAD_TABLE;

/** Whether a string names one of the allowed load-target schemas. */
export function isLoadSchema(value: string): value is LoadSchema {
  return (LOAD_SCHEMAS as readonly string[]).includes(value);
}

/**
 * Reduce a caller-supplied table name to a safe SQL identifier: drop any qualifier/`.`/path
 * components and replace anything outside `[A-Za-z0-9_]` with `_`, so a name like `raw.x` or
 * `"; DROP` collapses to a bare unqualified identifier that lands in the intended schema. Never
 * returns an empty string. Mirrors the dataset/upload/artifact sanitizers so every identifier
 * the platform derives from input is made safe the same way; the tool still double-quotes the
 * result as defense-in-depth.
 */
export function safeTableName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_]/g, "_");
  return cleaned.length > 0 ? cleaned : DEFAULT_TABLE_FALLBACK;
}

/**
 * Result of a successful `load_warehouse` load (PRD FR5). `rowCount` is read back from the
 * materialized table (not echoed from the Parquet), so it proves the load actually persisted
 * the rows — this is the "records row count loaded" the FR requires.
 */
export const LoadResultSchema = z.object({
  /** Target schema the table was created in (`raw` or `staging`). */
  schema: z.enum(LOAD_SCHEMAS),
  /** Sanitized table name (unqualified identifier). */
  table: z.string().min(1),
  /** Fully-qualified `<schema>.<table>` name the transform/DQ stages read from. */
  qualifiedTable: z.string().min(1),
  /** Landing-dataset root the Parquet was read from. */
  landingPath: z.string().min(1),
  /** Rows loaded, counted by reading the created table back. */
  rowCount: z.number().int().nonnegative(),
});
export type LoadResult = z.infer<typeof LoadResultSchema>;
