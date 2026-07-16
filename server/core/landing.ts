import { z } from "zod";

/**
 * Pure landing contract (PRD FR4). The "Land Parquet" pipeline stage writes the raw uploaded
 * CSV out to `data/landing/` as Parquet, partitioned by ingestion date — DuckDB's Hive layout
 * `<dataset>/ingestion_date=YYYY-MM-DD/*.parquet`. This is the MVP's "simulated S3" (see
 * ARCHITECTURE §3.4); the interface is written so a real S3/MinIO endpoint can slot in later.
 *
 * This module stays pure — no fs/net/process — so the dataset-name sanitizer, the ingestion-
 * date formatter, and the result shape can be reused by the `land_parquet` tool
 * ({@link file://../tools/land.ts}), the pipeline runner (T4.4) and the UI, and unit-tested in
 * isolation. The DuckDB `COPY` that does the write lives in the tool, never here.
 */

/**
 * The Hive partition column the land step adds to every landed dataset. Partitioning by the
 * ingestion date (rather than a source column) is the FR4 convention: each run's data lands
 * under its own `ingestion_date=<date>` directory, so re-landing a date overwrites just that
 * partition and history accumulates day by day.
 */
export const INGESTION_DATE_COLUMN = "ingestion_date";

/** Fallback dataset name when a caller-supplied name sanitizes to nothing. */
export const DEFAULT_LANDING_DATASET = "source";

/** `YYYY-MM-DD` — the ingestion-date partition-value format (an ISO calendar date). */
export const INGESTION_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Reduce a caller-supplied dataset name to a safe on-disk directory basename: drop any
 * directory components (defeating `../` path traversal) and replace anything outside
 * `[A-Za-z0-9._-]` with `_`. Never returns an empty string. Mirrors the upload/artifact
 * sanitizers ({@link file://./sources.ts}, {@link file://./artifacts.ts}) so every path the
 * platform derives from user input is traversal-safe the same way.
 */
export function safeDatasetName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, "_");
  return cleaned.length > 0 ? cleaned : DEFAULT_LANDING_DATASET;
}

/**
 * Format a {@link Date} as the `YYYY-MM-DD` ingestion-date partition value in UTC. UTC keeps
 * the partition boundary stable regardless of the server's local timezone, so the same instant
 * always lands in the same partition. Pure: the caller supplies the clock reading.
 */
export function formatIngestionDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Whether a string is a well-formed `YYYY-MM-DD` ingestion date. */
export function isIngestionDate(value: string): boolean {
  return INGESTION_DATE_REGEX.test(value);
}

/**
 * Result of a successful `land_parquet` write (PRD FR4). `landingPath` is the dataset root and
 * `partitionPath` the specific `ingestion_date=<date>` partition written this run; the load
 * step (T4.2) reads Parquet back from these. `rowCount` is read back from the landed Parquet
 * (not merely echoed from the source) so it proves the round-trip actually persisted the rows.
 */
export const LandResultSchema = z.object({
  /** Sanitized dataset name — the directory under the landing root. */
  dataset: z.string().min(1),
  /** Absolute-or-relative path to the dataset root directory under the landing dir. */
  landingPath: z.string().min(1),
  /** The ingestion date this run landed under, `YYYY-MM-DD`. */
  ingestionDate: z.string().regex(INGESTION_DATE_REGEX),
  /** Path to the `ingestion_date=<date>` partition directory written this run. */
  partitionPath: z.string().min(1),
  /** Rows landed, counted by reading the written Parquet back. */
  rowCount: z.number().int().nonnegative(),
});
export type LandResult = z.infer<typeof LandResultSchema>;
