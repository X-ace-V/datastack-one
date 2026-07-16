import type { WarehouseStore } from "./duckdb.js";
import {
  ArtifactSchema,
  type Artifact,
  type ArtifactKind,
} from "../core/artifacts.js";

/**
 * Persistence for generated artifacts (PRD FR3/FR6/FR7) in the DuckDB `platform.artifacts`
 * table. An I/O module by design — it wraps a {@link WarehouseStore} — so it lives under
 * `server/store`, not `server/core`. Every write binds user/agent input through parameters
 * ($1, $2, …); no field is ever concatenated into SQL. See ARCHITECTURE §3.4.
 */

/**
 * The column list every read selects. `created_at` is cast to VARCHAR so it arrives as a
 * plain string (`getRowObjects` otherwise returns a `DuckDBTimestampValue`) that
 * {@link ArtifactSchema} can validate directly.
 */
const ARTIFACT_COLUMNS =
  "id, project_id, run_id, kind, path, content, " +
  "CAST(created_at AS VARCHAR) AS created_at";

/** Map a raw `platform.artifacts` row (snake_case, nullable) to a validated {@link Artifact}. */
function rowToArtifact(row: Record<string, unknown>): Artifact {
  return ArtifactSchema.parse({
    id: row.id,
    projectId: row.project_id,
    runId: row.run_id ?? null,
    kind: row.kind,
    path: row.path ?? null,
    content: row.content ?? null,
    createdAt: row.created_at,
  });
}

/** Fields needed to record a generated artifact. `runId`/`path` are optional (nullable). */
export interface InsertArtifactInput {
  /** Application-generated artifact id (also used to name the file on disk). */
  id: string;
  /** Owning project. */
  projectId: string;
  /** Owning run, or `null`/absent when generated during planning (before a run exists). */
  runId?: string | null;
  /** Which kind of artifact this is (validated against the enum by the schema). */
  kind: ArtifactKind;
  /** On-disk path the artifact was written to, if any. */
  path?: string | null;
  /** The artifact text, stored inline so the review UI can render it without disk access. */
  content?: string | null;
}

/**
 * Insert an artifact and return it as persisted. The id is caller-generated (it names the
 * file on disk); `created_at` comes from the table default, so the row is read back after
 * the insert rather than echoing the input.
 */
export async function insertArtifact(
  store: WarehouseStore,
  input: InsertArtifactInput,
): Promise<Artifact> {
  await store.run(
    `INSERT INTO platform.artifacts (id, project_id, run_id, kind, path, content)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      input.id,
      input.projectId,
      input.runId ?? null,
      input.kind,
      input.path ?? null,
      input.content ?? null,
    ],
  );

  const rows = await store.all(
    `SELECT ${ARTIFACT_COLUMNS} FROM platform.artifacts WHERE id = $1`,
    [input.id],
  );
  const row = rows[0];
  if (!row) {
    throw new Error(`artifact ${input.id} was not found immediately after insert`);
  }
  return rowToArtifact(row);
}

/** Fetch a single artifact by id, or `null` if none exists. */
export async function getArtifact(
  store: WarehouseStore,
  id: string,
): Promise<Artifact | null> {
  const rows = await store.all(
    `SELECT ${ARTIFACT_COLUMNS} FROM platform.artifacts WHERE id = $1`,
    [id],
  );
  const row = rows[0];
  return row ? rowToArtifact(row) : null;
}

/** List a project's artifacts, newest first (id breaks ties for a stable order). */
export async function listArtifacts(
  store: WarehouseStore,
  projectId: string,
): Promise<Artifact[]> {
  const rows = await store.all(
    `SELECT ${ARTIFACT_COLUMNS} FROM platform.artifacts
     WHERE project_id = $1 ORDER BY created_at DESC, id`,
    [projectId],
  );
  return rows.map(rowToArtifact);
}

/**
 * Fetch a project's most recent artifact of a given kind, or `null` if none exists. Used to
 * surface the current rules doc (FR6): a project may have several rules submissions over
 * time, and the newest one is the one the plan stage reads.
 */
export async function getLatestArtifactByKind(
  store: WarehouseStore,
  projectId: string,
  kind: ArtifactKind,
): Promise<Artifact | null> {
  const rows = await store.all(
    `SELECT ${ARTIFACT_COLUMNS} FROM platform.artifacts
     WHERE project_id = $1 AND kind = $2 ORDER BY created_at DESC, id LIMIT 1`,
    [projectId, kind],
  );
  const row = rows[0];
  return row ? rowToArtifact(row) : null;
}
