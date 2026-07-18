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
