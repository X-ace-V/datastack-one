import { z } from "zod";

/**
 * Pure project contract (PRD FR1). A project is the top of the wizard: a named
 * workspace with a business domain, an expected data volume, a warehouse engine,
 * and a serving style. It is persisted in the DuckDB `platform.projects` table by
 * {@link file://../store/projects.ts} and exposed over `POST/GET /api/projects`.
 *
 * This module stays pure — no fs/net/process — so the request/response shapes can be
 * validated at the route boundary and reused by the store and the UI.
 */

/**
 * Warehouse engines a project may target. The MVP is DuckDB-only (PRD §2); the enum
 * exists so the API rejects anything else now and so additional engines slot in behind
 * one interface later (ARCHITECTURE §1.5) without loosening validation.
 */
export const WAREHOUSE_ENGINES = ["duckdb"] as const;
export type WarehouseEngine = (typeof WAREHOUSE_ENGINES)[number];

/**
 * Request body for `POST /api/projects`. `name` and `domain` are required; the rest are
 * optional descriptors. `warehouse` defaults to `duckdb` so a minimal create still lands
 * a valid row. Strings are trimmed so " " never passes as a non-empty name.
 */
export const CreateProjectRequestSchema = z.object({
  /** Human name for the project, e.g. "Loan Book". */
  name: z.string().trim().min(1),
  /** Business domain, e.g. "lending". */
  domain: z.string().trim().min(1),
  /** Rough expected data volume, e.g. "small" or "10M rows/day". Optional. */
  expectedVolume: z.string().trim().min(1).optional(),
  /** Warehouse engine; DuckDB-only in the MVP. */
  warehouse: z.enum(WAREHOUSE_ENGINES).default("duckdb"),
  /** How the final output is served, e.g. "rest" or "dashboard". Optional. */
  servingStyle: z.string().trim().min(1).optional(),
});
export type CreateProjectRequest = z.infer<typeof CreateProjectRequestSchema>;

/**
 * A persisted project as returned by the API. `expectedVolume`/`servingStyle` are
 * nullable because they are optional at create time; `createdAt` is the DB timestamp
 * rendered as a string. Field names are camelCase (the store maps the snake_case columns).
 */
export const ProjectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  domain: z.string().min(1),
  expectedVolume: z.string().nullable(),
  warehouse: z.string().min(1),
  servingStyle: z.string().nullable(),
  createdAt: z.string().min(1),
});
export type Project = z.infer<typeof ProjectSchema>;

/** Response body for `GET /api/projects` — the projects list, newest first. */
export const ProjectListResponseSchema = z.object({
  projects: z.array(ProjectSchema),
});
export type ProjectListResponse = z.infer<typeof ProjectListResponseSchema>;
