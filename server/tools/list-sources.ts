import type { WarehouseStore } from "../store/duckdb.js";
import { listSessionSources } from "../store/session-sources.js";
import { toListedSource, type ListedSource } from "../core/session-sources.js";

/**
 * The `list_sources` tool (PRD FR4, ARCHITECTURE §5). Read-only: it lists the sources connected
 * to a session as model-safe views (name + kind + row count) — the internal `path` is stripped
 * by {@link toListedSource} so the agent only ever sees the source's name (FR5b). Its permission
 * is `allow`. An I/O module (it queries the store), so it lives under `server/tools`.
 */
export async function listSourcesForSession(
  store: WarehouseStore,
  sessionId: string,
): Promise<ListedSource[]> {
  const sources = await listSessionSources(store, sessionId);
  return sources.map(toListedSource);
}
