import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin/tool";

/**
 * The single `@opencode-ai/plugin` that exposes DataStack One's data-engineering tools to the
 * agent (PRD FR4/FR6, ARCHITECTURE §3.4). OpenCode loads this file by URL into its OWN runtime
 * — a separate process from the Fastify backend — so it must be self-contained: it imports only
 * `@opencode-ai/plugin` and `zod` (both resolved from the project's `node_modules`), never this
 * repo's store/core modules. It cannot touch DuckDB directly; instead each tool `execute()`
 * calls back to the backend over loopback (`/api/internal/tools/*`), which owns the store. This
 * mirrors the Crux "internal.ts" loopback pattern the ARCHITECTURE cites.
 *
 * Two read-only tools ship here (V3.1): `list_sources` and `profile_source`. The write tools
 * (`land_parquet`, …) and `run_query` land in later phases. The agent addresses a source by its
 * `name`; the raw path is resolved backend-side and never crosses this boundary (FR5b).
 */

// zod, re-exported by the plugin SDK so the plugin and its host agree on one zod instance.
const z = tool.schema;

/** How long a loopback call may run before the tool gives up and reports a clear failure. */
const INTERNAL_CALL_TIMEOUT_MS = 30_000;

/**
 * Base URL of the Fastify backend to call back into. Set in the parent process before the
 * OpenCode server is spawned (see `server/index.ts`), so this subprocess inherits it in its
 * environment. Falls back to the default local port when unset (e.g. an ad-hoc boot).
 */
function backendBaseUrl(): string {
  return process.env.DATASTACK_INTERNAL_URL ?? "http://127.0.0.1:3001";
}

/** POST a JSON body to a backend loopback route and return the parsed envelope. */
async function callBackend(
  path: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), INTERNAL_CALL_TIMEOUT_MS);
  try {
    const res = await fetch(`${backendBaseUrl()}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch {
      /* non-JSON / empty body */
    }
    return { ok: res.ok, status: res.status, body: parsed };
  } finally {
    clearTimeout(timer);
  }
}

/** A model-safe source view as returned by `list_sources`. */
interface ListedSource {
  name: string;
  kind: string;
  rowCount: number | null;
}

/** A column of a source profile as returned by `profile_source`. */
interface ColumnProfile {
  name: string;
  type: string;
  nullPercent: number;
  distinctCount: number;
  isCandidateKey: boolean;
  isDateColumn: boolean;
}

/** The profile payload `profile_source` returns for one source. */
interface SourceProfile {
  rowCount: number;
  columns: ColumnProfile[];
  candidateKeys: string[];
  dateColumns: string[];
}

/** Render a profile as a compact, model-readable summary. */
function formatProfile(source: string, profile: SourceProfile): string {
  const lines = [
    `Source "${source}": ${profile.rowCount} rows, ${profile.columns.length} columns.`,
    "",
    "Columns:",
    ...profile.columns.map(
      (c) =>
        `  - ${c.name} (${c.type}) — ${c.nullPercent}% null, ${c.distinctCount} distinct` +
        `${c.isCandidateKey ? ", candidate key" : ""}${c.isDateColumn ? ", date" : ""}`,
    ),
  ];
  const keys = profile.candidateKeys.length > 0 ? profile.candidateKeys.join(", ") : "none";
  const dates = profile.dateColumns.length > 0 ? profile.dateColumns.join(", ") : "none";
  lines.push("", `Candidate keys: ${keys}`, `Date columns: ${dates}`);
  return lines.join("\n");
}

export const DatastackToolsPlugin: Plugin = async () => {
  return {
    tool: {
      list_sources: tool({
        description:
          "List the data sources connected to the current session (CSV uploads and, later, " +
          "registered databases) by name, kind, and row count. Call this first to see what " +
          "data is available before profiling or querying. Read-only; needs no approval.",
        args: {},
        async execute(_args, context) {
          const { ok, status, body } = await callBackend(
            "/api/internal/tools/list_sources",
            { sessionID: context.sessionID },
          );
          if (!ok) {
            return `Failed to list sources (status ${status}).`;
          }
          const sources = ((body as { sources?: ListedSource[] })?.sources ?? []);
          if (sources.length === 0) {
            return "No data sources are connected to this session yet. Upload a CSV to add one.";
          }
          const output = sources
            .map(
              (s) =>
                `- ${s.name} (${s.kind})${s.rowCount == null ? "" : ` — ${s.rowCount} rows`}`,
            )
            .join("\n");
          return {
            title: `${sources.length} source${sources.length === 1 ? "" : "s"}`,
            output,
            metadata: { sources },
          };
        },
      }),

      profile_source: tool({
        description:
          "Profile a connected source by name: schema, column types, row count, null %, " +
          "candidate primary keys, and date columns. Use the exact name from list_sources. " +
          "Read-only; needs no approval.",
        args: {
          source: z
            .string()
            .describe("The name of the connected source to profile (from list_sources)."),
        },
        async execute(args, context) {
          const { ok, status, body } = await callBackend(
            "/api/internal/tools/profile_source",
            { sessionID: context.sessionID, source: args.source },
          );
          if (status === 404) {
            return (
              `No source named "${args.source}" is connected to this session. ` +
              "Call list_sources to see the connected sources."
            );
          }
          if (status === 422) {
            return `Source "${args.source}" could not be read or profiled (it may not be valid CSV).`;
          }
          if (!ok) {
            return `Failed to profile "${args.source}" (status ${status}).`;
          }
          const payload = body as { source: string; profile: SourceProfile };
          return {
            title: `Profiled ${payload.source}`,
            output: formatProfile(payload.source, payload.profile),
            metadata: { profile: payload.profile },
          };
        },
      }),
    },
  };
};

export default DatastackToolsPlugin;
