import { z } from "zod";
import { ListedSourceSchema } from "./session-sources.js";
import { SourceProfileSchema } from "./profile.js";
import { QueryResultSchema } from "./query.js";

/**
 * Pure request/response contracts for the internal loopback the agent tools call
 * (ARCHITECTURE §3.4, "internal.ts"/loopback pattern; PRD FR4/FR6). The data-eng tools run
 * inside OpenCode's own runtime — a separate process from this backend — so they cannot touch
 * the DuckDB store directly; each tool `execute()` POSTs to `/api/internal/tools/*` on this
 * backend, which owns the store. These schemas are the wire contract for that hop.
 *
 * The `sessionID` in each request is the OpenCode session the tool call belongs to (the tool
 * reads it from its `ToolContext`), so the backend scopes the source lookup to that session.
 * No raw path or credential ever crosses this boundary in either direction (FR5b): requests
 * carry only the session id and a source **name**; responses carry only model-safe views.
 */

/** `list_sources` request: which session's connected sources to list. */
export const ListSourcesRequestSchema = z.object({
  sessionID: z.string().min(1),
});
export type ListSourcesRequest = z.infer<typeof ListSourcesRequestSchema>;

/** `list_sources` response: the session's sources as model-safe views (no paths). */
export const ListSourcesResponseSchema = z.object({
  sources: z.array(ListedSourceSchema),
});
export type ListSourcesResponse = z.infer<typeof ListSourcesResponseSchema>;

/** `profile_source` request: profile the named source connected to this session. */
export const ProfileSourceRequestSchema = z.object({
  sessionID: z.string().min(1),
  source: z.string().min(1),
});
export type ProfileSourceRequest = z.infer<typeof ProfileSourceRequestSchema>;

/** `profile_source` response: the source name plus its full profile (schema/types/keys). */
export const ProfileSourceResponseSchema = z.object({
  source: z.string().min(1),
  profile: SourceProfileSchema,
});
export type ProfileSourceResponse = z.infer<typeof ProfileSourceResponseSchema>;

/**
 * `run_query` request: run a read-only `SELECT` in the context of a session's connected sources.
 * Only the session id and the model-produced SQL cross the boundary — the SQL references sources
 * by their **name** (FR5b), and the backend resolves each name to its on-disk path when it exposes
 * the source to the query.
 */
export const RunQueryRequestSchema = z.object({
  sessionID: z.string().min(1),
  sql: z.string().min(1),
});
export type RunQueryRequest = z.infer<typeof RunQueryRequestSchema>;

/** `run_query` response: the query result (columns + rows) for the data panel. */
export const RunQueryResponseSchema = z.object({
  result: QueryResultSchema,
});
export type RunQueryResponse = z.infer<typeof RunQueryResponseSchema>;

/**
 * Wire contracts for the **write** tools (PRD FR8/FR10). These are the four approval-gated
 * tools — `land_parquet`, `load_warehouse`, `run_transform`, `publish_serving`. The plugin
 * pauses each turn for a human decision (`context.ask`) BEFORE it POSTs to the matching route
 * here, so the route only ever executes an already-approved write (the gate is enforced in the
 * plugin, not here — the loopback binds to 127.0.0.1 and is only reachable in-process). Every
 * request is scoped to a `sessionID`; no on-disk path or credential crosses the boundary in
 * either direction (FR5b), so the landing/serving destinations are derived server-side from the
 * session and a sanitized logical name, never sent by the model.
 */

/**
 * `land_parquet` request: land a session's connected source to Parquet. The model names the
 * source (resolved to its path backend-side); the ingestion date is optional (defaults to today).
 */
export const LandParquetRequestSchema = z.object({
  sessionID: z.string().min(1),
  source: z.string().min(1),
  ingestionDate: z.string().optional(),
});
export type LandParquetRequest = z.infer<typeof LandParquetRequestSchema>;

/** `land_parquet` response: the landed dataset, its ingestion date, and rows written (no path). */
export const LandParquetResponseSchema = z.object({
  dataset: z.string().min(1),
  ingestionDate: z.string().min(1),
  rowCount: z.number().int().nonnegative(),
});
export type LandParquetResponse = z.infer<typeof LandParquetResponseSchema>;

/**
 * `load_warehouse` request: load a previously-landed dataset (by its logical name) into the
 * warehouse. The backend reconstructs the landing path from the session + dataset — the model
 * never sees or sends a path. `schema`/`table` default to `raw.source`.
 */
export const LoadWarehouseRequestSchema = z.object({
  sessionID: z.string().min(1),
  dataset: z.string().min(1),
  schema: z.string().optional(),
  table: z.string().optional(),
});
export type LoadWarehouseRequest = z.infer<typeof LoadWarehouseRequestSchema>;

/** `load_warehouse` response: the qualified table created and rows loaded. */
export const LoadWarehouseResponseSchema = z.object({
  qualifiedTable: z.string().min(1),
  schema: z.string().min(1),
  table: z.string().min(1),
  rowCount: z.number().int().nonnegative(),
});
export type LoadWarehouseResponse = z.infer<typeof LoadWarehouseResponseSchema>;

/**
 * `run_transform` request: execute the reviewed transform SQL into `marts.<targetTable>`. The
 * SQL is the exact text a human approved at the gate; it runs verbatim.
 */
export const RunTransformRequestSchema = z.object({
  sessionID: z.string().min(1),
  sql: z.string().min(1),
  targetTable: z.string().min(1),
});
export type RunTransformRequest = z.infer<typeof RunTransformRequestSchema>;

/** `run_transform` response: the qualified `marts` table created and rows written. */
export const RunTransformResponseSchema = z.object({
  qualifiedTable: z.string().min(1),
  table: z.string().min(1),
  rowCount: z.number().int().nonnegative(),
});
export type RunTransformResponse = z.infer<typeof RunTransformResponseSchema>;

/**
 * `publish_serving` request: publish a `marts` table as a served endpoint + CSV export. The
 * served name (URL segment) defaults to the table name; the export destination is derived
 * server-side under the session's serving dir.
 */
export const PublishServingRequestSchema = z.object({
  sessionID: z.string().min(1),
  table: z.string().min(1),
  name: z.string().optional(),
});
export type PublishServingRequest = z.infer<typeof PublishServingRequestSchema>;

/** `publish_serving` response: the served name, its REST endpoints, and rows served (no path). */
export const PublishServingResponseSchema = z.object({
  name: z.string().min(1),
  endpoint: z.string().min(1),
  csvEndpoint: z.string().min(1),
  rowCount: z.number().int().nonnegative(),
});
export type PublishServingResponse = z.infer<typeof PublishServingResponseSchema>;
