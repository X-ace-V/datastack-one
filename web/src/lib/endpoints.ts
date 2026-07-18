// Web mirror of the backend `publish_serving` result contract (server/tools/plugin.ts `PublishResult`)
// plus the selector the data panel uses to pull published endpoints out of the live chat stream
// (TASKS V4.2, PRD FR10/FR11/FR12). The panel renders endpoints *from tool events*: `publish_serving`
// attaches its `{name, endpoint, csvEndpoint, rowCount}` to the tool call's `metadata` under a
// `publish` key, which rides the SSE tool event into the session store; here we read it back out —
// the exact seam `run_query` (lib/query.ts) and `profile_source` (lib/profile.ts) use. Kept as plain
// types (no zod) like lib/api.ts mirrors the REST schemas.

import type { ChatMessage } from "../store/sessionStore";

/** The tool name whose metadata carries a published endpoint. */
export const PUBLISH_SERVING_TOOL = "publish_serving";

/** One published REST endpoint, mirror of the backend `publish_serving` result. */
export interface PublishedEndpoint {
  /** Served name — the identity and the URL segment. */
  name: string;
  /** Ready-to-use REST URL (`/api/serve/:name`), derived server-side. */
  endpoint: string;
  /** Ready-to-use CSV download URL (`/api/serve/:name.csv`), derived server-side. */
  csvEndpoint: string;
  /** Rows served, counted at publish time. */
  rowCount: number;
}

/** Whether a value is a finite number (JSON never yields NaN/Infinity, but be defensive). */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Read a {@link PublishedEndpoint} out of a tool call's `metadata`, or `null` if it is absent or the
 * wrong shape. Defensive because the metadata arrives from the network as `Record<string, unknown>`:
 * a malformed payload must not crash the panel, it should simply render nothing. Mirrors
 * {@link file://./query.ts}'s `readQueryResult`.
 */
export function readPublishedEndpoint(
  metadata: Record<string, unknown> | undefined,
): PublishedEndpoint | null {
  const publish = (metadata as { publish?: unknown } | undefined)?.publish;
  if (!publish || typeof publish !== "object") return null;
  const candidate = publish as Record<string, unknown>;
  if (
    typeof candidate.name !== "string" ||
    typeof candidate.endpoint !== "string" ||
    typeof candidate.csvEndpoint !== "string" ||
    !isFiniteNumber(candidate.rowCount)
  ) {
    return null;
  }
  return {
    name: candidate.name,
    endpoint: candidate.endpoint,
    csvEndpoint: candidate.csvEndpoint,
    rowCount: candidate.rowCount,
  };
}

/**
 * Every endpoint published across a session's transcript, most recently published first, deduped by
 * served name — a re-publish of the same name replaces the earlier row, so the surviving entry
 * carries the freshest row count (the registry itself is keyed by name, `ON CONFLICT DO UPDATE`).
 * Unlike the single-latest profile/query selectors, the panel shows ALL live endpoints: a session can
 * publish several distinct marts. Returns an empty array when nothing has been published yet.
 */
export function latestEndpoints(messages: ChatMessage[]): PublishedEndpoint[] {
  const seen = new Set<string>();
  const endpoints: PublishedEndpoint[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || message.role !== "assistant") continue;
    for (let j = message.blocks.length - 1; j >= 0; j--) {
      const block = message.blocks[j];
      if (
        block &&
        block.kind === "tool" &&
        block.tool === PUBLISH_SERVING_TOOL &&
        block.status === "completed"
      ) {
        const endpoint = readPublishedEndpoint(block.metadata);
        if (endpoint && !seen.has(endpoint.name)) {
          seen.add(endpoint.name);
          endpoints.push(endpoint);
        }
      }
    }
  }
  return endpoints;
}
