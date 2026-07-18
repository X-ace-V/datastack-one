import { afterEach, describe, expect, it } from "vitest";
import { openStore, type WarehouseStore } from "../store/duckdb.js";
import { attachPostgres, PostgresAttachError } from "./attach.js";

/**
 * Tests for the real name-based Postgres attacher (V5.2, FR5b). The happy path needs a live
 * Postgres, so it is gated behind `TEST_PG_URL` and SKIPS cleanly when unset (mirrors the V5.1
 * probe). The negative path runs fully OFFLINE against a real DuckDB store: it drives the actual
 * `INSTALL/LOAD postgres` + `ATTACH` and asserts the failure is a `PostgresAttachError` whose
 * message has the credential scrubbed — the load-bearing invariant, since the DuckDB Postgres
 * driver echoes the full connection string (password included) into its error text.
 */
describe("attachPostgres", () => {
  const open: WarehouseStore[] = [];

  afterEach(async () => {
    await Promise.all(open.splice(0).map((s) => s.close()));
  });

  async function store(): Promise<WarehouseStore> {
    const s = await openStore(":memory:");
    open.push(s);
    return s;
  }

  it("throws a secret-scrubbed error when the database is unreachable", async () => {
    const s = await store();
    // A syntactically valid URL pointing at a closed port: the driver refuses fast and echoes the
    // full connection string — with the password — into its error, which must NOT survive.
    const url = "postgresql://alice:hunter2@127.0.0.1:1/lending";

    await expect(attachPostgres(s, { alias: "neon", url })).rejects.toBeInstanceOf(
      PostgresAttachError,
    );

    let message = "";
    try {
      await attachPostgres(s, { alias: "neon", url });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    // The credential is gone; the URL is replaced by the redaction placeholder.
    expect(message).not.toContain("hunter2");
    expect(message).not.toContain(url);
    expect(message).toMatch(/<connection>|<credentials>/);
    // Nothing was attached: the alias is absent from the catalog.
    const dbs = await s.all(
      "SELECT database_name FROM duckdb_databases() WHERE database_name = 'neon'",
    );
    expect(dbs).toHaveLength(0);
  });

  const TEST_PG_URL = process.env.TEST_PG_URL;
  it.runIf(TEST_PG_URL)(
    "attaches a real Postgres read-only and introspects its tables (TEST_PG_URL)",
    async () => {
      const s = await store();
      const result = await attachPostgres(s, { alias: "neon", url: TEST_PG_URL! });

      // The introspection returns well-formed tables (schema + name + typed columns) — the "schema"
      // the agent sees. A seeded lending DB has tables; assert the shape regardless of contents.
      expect(Array.isArray(result.tables)).toBe(true);
      for (const table of result.tables) {
        expect(typeof table.schema).toBe("string");
        expect(typeof table.table).toBe("string");
        expect(Array.isArray(table.columns)).toBe(true);
        for (const col of table.columns) {
          expect(col.name.length).toBeGreaterThan(0);
          expect(col.type.length).toBeGreaterThan(0);
        }
      }

      // The database is attached read-only in the catalog, and a re-attach is idempotent (no throw).
      const dbs = await s.all(
        "SELECT database_name FROM duckdb_databases() WHERE database_name = 'neon'",
      );
      expect(dbs).toHaveLength(1);
      await expect(attachPostgres(s, { alias: "neon", url: TEST_PG_URL! })).resolves.toBeDefined();
    },
  );
});
