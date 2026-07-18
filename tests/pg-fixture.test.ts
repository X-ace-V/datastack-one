import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { attachPostgres } from "../server/connections/attach.js";
import { openStore, type WarehouseStore } from "../server/store/duckdb.js";
import { registerSessionSource } from "../server/store/session-sources.js";
import { runQuery } from "../server/tools/query.js";

/**
 * Contract + live-wiring test for the committed Postgres seed fixture (V5.4, PRD FR5b / §5
 * "connect a Postgres and join a CSV to a PG table").
 *
 * Two layers, so the fixture is honest whether or not a Neon database is on hand:
 *
 *  1. OFFLINE (always runs): `fixtures/pg_seed.sql` is written in the SQL subset both Postgres
 *     and DuckDB accept, so the same file seeds an in-memory DuckDB here. This proves the seed
 *     is valid, load-bearing SQL that yields the branches/loans the demo joins against — and that
 *     `branches` covers **every** branch in `loans_sample.csv`, so an INNER JOIN drops no row.
 *
 *  2. LIVE (gated on `TEST_PG_URL`, SKIPS cleanly when unset): the real name-based attach
 *     (`attachPostgres`, V5.2) points at a Neon seeded with this exact file, then `run_query`
 *     joins the CSV upload to `neon.public.branches` by qualified name — the actual FR5b path.
 *
 * The two layers assert the SAME join result (loans per region), so the offline contract and the
 * live wiring can never silently diverge.
 */

const seedPath = fileURLToPath(new URL("../fixtures/pg_seed.sql", import.meta.url));
const csvPath = fileURLToPath(new URL("../fixtures/loans_sample.csv", import.meta.url));

/** The join result the whole scenario turns on: loans per region, ordered by region. */
const LOANS_PER_REGION = [
  { region: "Eastern", loans: 6 },
  { region: "Northern", loans: 7 },
  { region: "Southern", loans: 6 },
  { region: "Western", loans: 5 },
] as const;

/**
 * Split the seed into executable statements. The seed contains no `;` inside a string literal, so
 * a naive split is safe; full-line `--` comments are stripped first. Both Postgres and DuckDB run
 * the resulting statements verbatim.
 */
function seedStatements(): string[] {
  return readFileSync(seedPath, "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

describe("pg_seed.sql (offline DuckDB contract)", () => {
  const open: WarehouseStore[] = [];

  afterEach(async () => {
    await Promise.all(open.splice(0).map((s) => s.close()));
  });

  async function seededStore(): Promise<WarehouseStore> {
    const store = await openStore(":memory:");
    open.push(store);
    for (const statement of seedStatements()) {
      await store.run(statement);
    }
    return store;
  }

  it("executes as valid SQL and seeds both reference tables", async () => {
    const store = await seededStore();

    const branches = await store.all(
      "SELECT branch, region FROM branches ORDER BY branch",
    );
    expect(branches).toEqual([
      { branch: "east", region: "Eastern" },
      { branch: "north", region: "Northern" },
      { branch: "south", region: "Southern" },
      { branch: "west", region: "Western" },
    ]);

    // The loan book has more than one row, so the attached DB is a real multi-table schema.
    const [{ n: loanCount }] = (await store.all(
      "SELECT count(*) AS n FROM loans",
    )) as [{ n: bigint }];
    expect(Number(loanCount)).toBe(10);

    // Every live loan points at a real branch (the FK holds), so joins never drop a loan.
    const [{ orphans }] = (await store.all(
      "SELECT count(*) AS orphans FROM loans l LEFT JOIN branches b ON l.branch = b.branch WHERE b.branch IS NULL",
    )) as [{ orphans: bigint }];
    expect(Number(orphans)).toBe(0);
  });

  it("covers every branch in loans_sample.csv, so the CSV↔PG join drops no row", async () => {
    const store = await seededStore();

    // Total joined rows equal the CSV's 24 rows: the seed's branch keys are a superset of the
    // CSV's, which is the load-bearing property — a missing branch would silently shrink this.
    const [{ joined }] = (await store.all(
      "SELECT count(*) AS joined FROM read_csv_auto(?) l JOIN branches b ON l.branch = b.branch",
      [csvPath],
    )) as [{ joined: bigint }];
    expect(Number(joined)).toBe(24);
  });

  it("groups the CSV loans by the branch region the PG table supplies", async () => {
    const store = await seededStore();

    const rows = await store.all(
      "SELECT b.region, count(*) AS loans FROM read_csv_auto(?) l " +
        "JOIN branches b ON l.branch = b.branch GROUP BY b.region ORDER BY b.region",
      [csvPath],
    );

    expect(rows.map((r) => ({ region: String(r.region), loans: Number(r.loans) }))).toEqual([
      ...LOANS_PER_REGION,
    ]);
  });
});

describe("live Postgres attach + CSV↔PG join (TEST_PG_URL)", () => {
  const TEST_PG_URL = process.env.TEST_PG_URL;
  const open: WarehouseStore[] = [];

  afterEach(async () => {
    await Promise.all(open.splice(0).map((s) => s.close()));
  });

  it.runIf(TEST_PG_URL)(
    "attaches a Neon seeded with pg_seed.sql and joins the CSV to it by name",
    async () => {
      const store = await openStore(":memory:");
      open.push(store);

      // Real name-based attach (V5.2): resolve the URL server-side, ATTACH read-only, introspect.
      const result = await attachPostgres(store, { alias: "neon", url: TEST_PG_URL! });

      const tables = new Map(result.tables.map((t) => [`${t.schema}.${t.table}`, t]));
      const branches = tables.get("public.branches");
      const loans = tables.get("public.loans");
      expect(branches, "public.branches must be present — did you run pg_seed.sql?").toBeDefined();
      expect(loans, "public.loans must be present — did you run pg_seed.sql?").toBeDefined();
      expect(branches!.columns.map((c) => c.name)).toEqual(
        expect.arrayContaining(["branch", "region", "manager", "opened_on"]),
      );

      // The FR5b query path: the CSV upload is a session source addressed by name; the attached
      // Postgres table is addressed by its qualified `neon.public.branches` name (no view built).
      await registerSessionSource(store, {
        sessionId: "ses_pg",
        name: "loans_csv",
        path: csvPath,
      });

      const query = await runQuery(store, {
        sessionId: "ses_pg",
        sql:
          "SELECT b.region, count(*) AS loans FROM loans_csv l " +
          "JOIN neon.public.branches b ON l.branch = b.branch " +
          "GROUP BY b.region ORDER BY b.region",
      });

      expect(
        query.rows.map((r) => ({ region: String(r.region), loans: Number(r.loans) })),
      ).toEqual([...LOANS_PER_REGION]);
    },
    60_000,
  );
});
