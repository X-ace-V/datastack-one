import { z } from "zod";

/**
 * Pure contract for the Settings → Connections feature (PRD FR5, ARCHITECTURE §3.7). A
 * connection is a named, credentialed pointer to a live database (Postgres/Neon in the MVP)
 * that the user registers **once** in Settings. The raw URL is a secret: it is stored
 * server-side (gitignored) and resolved to run SQL, but it NEVER reaches the browser list,
 * the chat, an SSE event, or a model prompt — the agent addresses the database by its `name`
 * only (FR5b). This module stays pure (no fs/net/process) so its shapes and the secret-scrub
 * logic can be reused by the store, the routes, and the connection tester, and unit-tested in
 * isolation.
 */

/**
 * The database types a connection can point at. Postgres is the only MVP type (FR5); the enum
 * leaves room for others without widening the schema silently.
 */
export const CONNECTION_TYPES = ["postgres"] as const;
export type ConnectionType = (typeof CONNECTION_TYPES)[number];
export const ConnectionTypeSchema = z.enum(CONNECTION_TYPES);

/**
 * A connection name. It doubles as the DuckDB `ATTACH … AS <name>` alias the agent references
 * (V5.2, FR5b), so it must be a clean SQL identifier: a letter or underscore followed by
 * letters/digits/underscores. Rejecting dashes/dots/spaces/leading digits here means the name
 * can be interpolated as an identifier later without any quoting ambiguity or injection risk.
 */
export const ConnectionNameSchema = z
  .string()
  .trim()
  .min(1, "connection name is required")
  .max(63, "connection name is too long")
  .regex(
    /^[A-Za-z_][A-Za-z0-9_]*$/,
    "connection name must start with a letter or underscore and contain only letters, digits, or underscores",
  );

/** True iff `url` is a Postgres connection string (`postgres://` or `postgresql://`). */
export function isPostgresUrl(url: string): boolean {
  return /^postgres(ql)?:\/\//i.test(url.trim());
}

/**
 * The credentialed connection URL. Validated for the `postgres`/`postgresql` scheme so a
 * typo'd or non-Postgres URL is a 400 at the door rather than an opaque failure when the
 * backend later tries to ATTACH it.
 */
export const ConnectionUrlSchema = z
  .string()
  .trim()
  .min(1, "connection url is required")
  .refine(isPostgresUrl, "connection url must be a postgres:// or postgresql:// URL");

/**
 * The request body to register a connection (`POST /api/connections`). The URL is entered ONLY
 * here (ARCHITECTURE §3.7) and is the sole place a secret crosses into the backend.
 */
export const CreateConnectionRequestSchema = z.object({
  name: ConnectionNameSchema,
  type: ConnectionTypeSchema.default("postgres"),
  url: ConnectionUrlSchema,
});
export type CreateConnectionRequest = z.infer<typeof CreateConnectionRequestSchema>;

/**
 * A connection as persisted server-side — INCLUDING the secret `url`. This shape never leaves
 * the backend: the store returns it so the tester/attach path (V5.2) can resolve name → URL,
 * but every API response projects it down to {@link ConnectionSchema} first.
 */
export const StoredConnectionSchema = z.object({
  name: z.string().min(1),
  type: ConnectionTypeSchema,
  url: z.string().min(1),
  createdAt: z.string().min(1),
});
export type StoredConnection = z.infer<typeof StoredConnectionSchema>;

/**
 * The safe, client-facing view of a connection: `name` + `type` + `createdAt`, with the secret
 * `url` deliberately absent from the shape. This is what every `/api/connections` response
 * carries, so a leak is a schema mismatch, not a subtle field — the API can never return a
 * secret because the secret is not part of the contract.
 */
export const ConnectionSchema = z.object({
  name: z.string().min(1),
  type: ConnectionTypeSchema,
  createdAt: z.string().min(1),
});
export type Connection = z.infer<typeof ConnectionSchema>;

/** Project a persisted {@link StoredConnection} down to its secret-free {@link Connection} view. */
export function toConnectionView(connection: StoredConnection): Connection {
  return {
    name: connection.name,
    type: connection.type,
    createdAt: connection.createdAt,
  };
}

/**
 * The outcome of a test-connection probe (`POST /api/connections/:name/test`). `ok` is whether
 * the backend could reach and open the database read-only; `error` is a **scrubbed** failure
 * message (never the raw URL — see {@link redactConnectionSecret}) or null on success.
 */
export const ConnectionTestResultSchema = z.object({
  ok: z.boolean(),
  error: z.string().nullable(),
});
export type ConnectionTestResult = z.infer<typeof ConnectionTestResultSchema>;

/**
 * Scrub a connection secret out of a message before it can leave the backend. The DuckDB
 * Postgres driver echoes the full connection string (with the password) into its error text,
 * so a raw ATTACH failure would leak the credential to the client. This removes the exact URL
 * and, defensively, masks any `scheme://user:pass@` credential still present after a reformat.
 */
export function redactConnectionSecret(message: string, url: string): string {
  let scrubbed = message;
  const trimmed = url.trim();
  if (trimmed.length > 0) {
    scrubbed = scrubbed.split(trimmed).join("<connection>");
  }
  // Defense-in-depth: mask `://user:password@` (or `://user@`) credentials the driver may have
  // reformatted so they don't survive even if the exact URL string didn't match.
  scrubbed = scrubbed.replace(
    /(\/\/)[^/\s:@]+(?::[^/\s@]*)?@/g,
    "$1<credentials>@",
  );
  return scrubbed;
}
