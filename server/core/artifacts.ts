import { z } from "zod";

/**
 * Pure artifact contract (PRD FR3/FR6/FR7). An artifact is a generated document the agent
 * produces for human review before anything executes — the transformation rules the user
 * supplies, the architecture plan, the transform SQL, the DDL, the DQ spec, the serving
 * spec. Each is written to disk under `data/artifacts/` and recorded in the DuckDB
 * `platform.artifacts` table by {@link file://../store/artifacts.ts}; the I/O of writing
 * one lives in the `write_artifact` tool ({@link file://../tools/rules.ts}), never here.
 *
 * This module stays pure — no fs/net/process — so the artifact-kind enum, filename
 * sanitizer, and request/row schemas can be reused by the tool, the store, the routes, and
 * the UI, and unit-tested in isolation.
 */

/**
 * The artifact kinds the MVP pipeline produces. `rules` is the plain-English transformation
 * rules document the user provides (FR6); the rest are agent-generated review artifacts.
 * This list is the single source of truth the schema validates against, so an unknown kind
 * is rejected at the boundary rather than silently stored.
 */
export const ARTIFACT_KINDS = [
  "rules",
  "plan",
  "transform_sql",
  "ddl",
  "dq_spec",
  "serving_spec",
] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/** Fallback basename when a supplied artifact name sanitizes to nothing. */
export const DEFAULT_ARTIFACT_FILENAME = "artifact.txt";

/**
 * Reduce a caller-supplied artifact name to a safe on-disk basename: drop any directory
 * components (defeating `../` path traversal) and replace anything outside `[A-Za-z0-9._-]`
 * with `_`. Never returns an empty string. Mirrors {@link file://./sources.ts}'s
 * `safeUploadFilename` so both upload and artifact writes are traversal-safe the same way.
 */
export function safeArtifactFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, "_");
  return cleaned.length > 0 ? cleaned : DEFAULT_ARTIFACT_FILENAME;
}

/**
 * A persisted artifact as returned by the API and stored in `platform.artifacts`. `runId` is
 * nullable because artifacts are generated during planning, before a run exists. `path` is
 * the on-disk location; `content` is the same text stored inline so the review UI can render
 * it without reading disk. Field names are camelCase; the store maps the snake_case columns.
 */
export const ArtifactSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  runId: z.string().min(1).nullable(),
  kind: z.enum(ARTIFACT_KINDS),
  path: z.string().min(1).nullable(),
  content: z.string().nullable(),
  createdAt: z.string().min(1),
});
export type Artifact = z.infer<typeof ArtifactSchema>;

/** Response body for `GET /api/projects/:id/rules` — the latest rules artifact, or null. */
export const RulesResponseSchema = z.object({
  rules: ArtifactSchema.nullable(),
});
export type RulesResponse = z.infer<typeof RulesResponseSchema>;

/**
 * Response body for `GET /api/projects/:id/artifacts` — the newest artifact of each kind the
 * Review step (FR3/FR6/FR7) inspects before execution: the architecture plan, the transform
 * SQL, the DDL, and the DQ spec. Each is `null` until its generation stage has run, so the
 * review UI can show what is still missing. The raw artifacts are returned (content included)
 * so the client renders each from its stored payload without a second round-trip.
 */
export const ReviewArtifactsResponseSchema = z.object({
  plan: ArtifactSchema.nullable(),
  transform: ArtifactSchema.nullable(),
  ddl: ArtifactSchema.nullable(),
  dq: ArtifactSchema.nullable(),
});
export type ReviewArtifactsResponse = z.infer<typeof ReviewArtifactsResponseSchema>;

/**
 * Body of `POST /api/projects/:id/rules` when the rules arrive as JSON from the UI textarea
 * (as opposed to a multipart file upload). `.trim()` before `.min(1)` rejects a
 * whitespace-only submission, so an empty rules doc can never be stored.
 */
export const RulesInputSchema = z.object({
  rules: z.string().trim().min(1),
});
export type RulesInput = z.infer<typeof RulesInputSchema>;
