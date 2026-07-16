import { randomUUID } from "node:crypto";
import type { WarehouseStore } from "./duckdb.js";
import {
  ProjectSchema,
  type CreateProjectRequest,
  type Project,
} from "../core/projects.js";

/**
 * Persistence for projects (PRD FR1) in the DuckDB `platform.projects` table. An I/O
 * module by design — it wraps a {@link WarehouseStore} — so it lives under `server/store`,
 * not `server/core`. Every write binds user input through parameters ($1, $2, …); no
 * request field is ever concatenated into SQL. See ARCHITECTURE §3.4.
 */

/**
 * The column list every read selects. `created_at` is cast to VARCHAR so it arrives as a
 * plain ISO-ish string (`getRowObjects` otherwise returns a `DuckDBTimestampValue` object)
 * that {@link ProjectSchema} can validate directly.
 */
const PROJECT_COLUMNS =
  "id, name, domain, expected_volume, warehouse, serving_style, " +
  "CAST(created_at AS VARCHAR) AS created_at";

/** Map a raw `platform.projects` row (snake_case, nullable) to a validated {@link Project}. */
function rowToProject(row: Record<string, unknown>): Project {
  return ProjectSchema.parse({
    id: row.id,
    name: row.name,
    domain: row.domain,
    expectedVolume: row.expected_volume ?? null,
    warehouse: row.warehouse,
    servingStyle: row.serving_style ?? null,
    createdAt: row.created_at,
  });
}

/**
 * Insert a project and return it as persisted. The id is server-generated; `created_at`
 * and the `warehouse` default are supplied by the table, so the row is read back after the
 * insert rather than echoing the request — the caller sees exactly what was stored.
 */
export async function insertProject(
  store: WarehouseStore,
  input: CreateProjectRequest,
): Promise<Project> {
  const id = randomUUID();
  await store.run(
    `INSERT INTO platform.projects
       (id, name, domain, expected_volume, warehouse, serving_style)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      id,
      input.name,
      input.domain,
      input.expectedVolume ?? null,
      input.warehouse,
      input.servingStyle ?? null,
    ],
  );

  const rows = await store.all(
    `SELECT ${PROJECT_COLUMNS} FROM platform.projects WHERE id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row) {
    throw new Error(`project ${id} was not found immediately after insert`);
  }
  return rowToProject(row);
}

/** List all projects, newest first (id breaks ties for a stable order). */
export async function listProjects(store: WarehouseStore): Promise<Project[]> {
  const rows = await store.all(
    `SELECT ${PROJECT_COLUMNS} FROM platform.projects ORDER BY created_at DESC, id`,
  );
  return rows.map(rowToProject);
}
