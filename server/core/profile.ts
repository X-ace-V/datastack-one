import { z } from "zod";

/**
 * Pure source-profile contract (PRD FR2). Given the raw counts a profiler gathers from a
 * CSV — the total row count plus each column's DuckDB type, null count and distinct count —
 * this module classifies them into the profile the UI renders: schema, column types, row
 * count, null %, candidate primary keys and date columns.
 *
 * It stays pure (no fs/net/process) so the classification is unit-testable in isolation and
 * reused by the DuckDB profiler tool ({@link file://../tools/profile.ts}), the profile route
 * (T2.4) and the UI. The I/O — running `read_csv_auto` — lives in the tool, never here.
 */

/**
 * DuckDB type-name prefixes that denote a temporal column. `read_csv_auto` infers `DATE`,
 * `TIME`, `TIMESTAMP`, `TIMESTAMP WITH TIME ZONE`, `TIMESTAMP_NS`, etc.; every temporal type
 * name begins with one of these, so a prefix match is a stable classifier across versions.
 */
export const DATE_TYPE_PREFIXES = ["DATE", "TIMESTAMP", "TIME"] as const;

/** Whether a DuckDB column type is a date/time type (case-insensitive prefix match). */
export function isDateType(columnType: string): boolean {
  const upper = columnType.trim().toUpperCase();
  return DATE_TYPE_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

/**
 * Null fraction of a column as a percentage in `[0, 100]`, rounded to two decimals. An empty
 * source (zero rows) has no nulls to speak of, so it is defined as `0`.
 */
export function computeNullPercent(nullCount: number, rowCount: number): number {
  if (rowCount <= 0) return 0;
  return Math.round((nullCount / rowCount) * 10000) / 100;
}

/**
 * Whether a column is a candidate primary key: every row present (no nulls) and every value
 * distinct. `count(DISTINCT col)` excludes nulls, so requiring `nullCount === 0` alongside
 * `distinctCount === rowCount` is the full uniqueness test. An empty source has no key.
 */
export function isCandidateKey(
  nullCount: number,
  distinctCount: number,
  rowCount: number,
): boolean {
  return rowCount > 0 && nullCount === 0 && distinctCount === rowCount;
}

/** Per-column profile as returned to the UI (PRD FR2). */
export const ColumnProfileSchema = z.object({
  /** Column name, taken verbatim from the CSV header. */
  name: z.string().min(1),
  /** DuckDB-inferred type (e.g. `BIGINT`, `VARCHAR`, `DOUBLE`, `DATE`). */
  type: z.string().min(1),
  /** Number of null cells in this column. */
  nullCount: z.number().int().nonnegative(),
  /** Null cells as a percentage of the row count, in `[0, 100]`. */
  nullPercent: z.number().min(0).max(100),
  /** Distinct non-null values in this column. */
  distinctCount: z.number().int().nonnegative(),
  /** True when the column uniquely identifies every row (candidate primary key). */
  isCandidateKey: z.boolean(),
  /** True when the column's inferred type is temporal. */
  isDateColumn: z.boolean(),
});
export type ColumnProfile = z.infer<typeof ColumnProfileSchema>;

/** Full source profile for one CSV (PRD FR2), rendered by the `SchemaTable` in T2.4. */
export const SourceProfileSchema = z.object({
  /** Total rows in the source. */
  rowCount: z.number().int().nonnegative(),
  /** Number of columns. */
  columnCount: z.number().int().nonnegative(),
  /** One entry per column, in file order. */
  columns: z.array(ColumnProfileSchema),
  /** Names of the candidate primary-key columns (a convenience view over `columns`). */
  candidateKeys: z.array(z.string()),
  /** Names of the date/time columns (a convenience view over `columns`). */
  dateColumns: z.array(z.string()),
});
export type SourceProfile = z.infer<typeof SourceProfileSchema>;

/**
 * Body of `POST /api/projects/:id/profile` (T2.4). Profiling targets one uploaded source;
 * `sourceId` names it explicitly, and when omitted the route profiles the project's most
 * recent source. The body may be absent entirely, so both fields are optional.
 */
export const ProfileRequestSchema = z.object({
  /** Id of the source to profile; defaults to the project's newest source when omitted. */
  sourceId: z.string().min(1).optional(),
});
export type ProfileRequest = z.infer<typeof ProfileRequestSchema>;

/** Raw per-column statistics a profiler gathers before classification. */
export interface RawColumnStat {
  /** Column name from the CSV header. */
  name: string;
  /** DuckDB-inferred type. */
  type: string;
  /** Null cells in the column. */
  nullCount: number;
  /** Distinct non-null values in the column. */
  distinctCount: number;
}

/**
 * Assemble a validated {@link SourceProfile} from the row count and per-column raw stats.
 * Pure: it derives null %, candidate-key and date-column classifications and the two
 * convenience name lists, then parses through {@link SourceProfileSchema} so every caller
 * gets an already-validated profile.
 */
export function buildSourceProfile(
  rowCount: number,
  stats: RawColumnStat[],
): SourceProfile {
  const columns: ColumnProfile[] = stats.map((stat) => ({
    name: stat.name,
    type: stat.type,
    nullCount: stat.nullCount,
    nullPercent: computeNullPercent(stat.nullCount, rowCount),
    distinctCount: stat.distinctCount,
    isCandidateKey: isCandidateKey(stat.nullCount, stat.distinctCount, rowCount),
    isDateColumn: isDateType(stat.type),
  }));

  return SourceProfileSchema.parse({
    rowCount,
    columnCount: columns.length,
    columns,
    candidateKeys: columns.filter((c) => c.isCandidateKey).map((c) => c.name),
    dateColumns: columns.filter((c) => c.isDateColumn).map((c) => c.name),
  });
}
