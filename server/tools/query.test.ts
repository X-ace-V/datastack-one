import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openStore, type WarehouseStore } from "../store/duckdb.js";
import { registerSessionSource } from "../store/session-sources.js";
import { NonReadOnlyQueryError } from "../core/query.js";
import { runQuery } from "./query.js";

/**
 * Integration test for the `run_query` tool (V3.3, PRD FR7) against a real DuckDB read of synthetic
 * CSV sources registered to a session. Asserts the desired result — the agent references a source
 * by its NAME (FR5b), gets the right rows/columns back, can join two sources and aggregate, and a
 * non-read-only or malformed query is rejected — not merely that the call returns. The pure guard +
 * assembly is covered in {@link file://../core/query.test.ts}.
 */
describe("run_query tool (read-only SELECT over DuckDB)", () => {
  const open: WarehouseStore[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(open.splice(0).map((s) => s.close()));
    await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function fixtureCsv(name: string, contents: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "query-"));
    tempDirs.push(dir);
    const path = join(dir, name);
    await writeFile(path, contents);
    return path;
  }

  async function freshStore(): Promise<WarehouseStore> {
    const store = await openStore(":memory:");
    open.push(store);
    return store;
  }

  // Synthetic lending source: a null balance in the south branch, two north rows.
  const LOANS_CSV =
    "loan_id,branch,balance,opened_at\n" +
    "1,north,1000.50,2024-01-01\n" +
    "2,south,,2024-01-02\n" +
    "3,north,750.25,2024-02-15\n";

  const BRANCHES_CSV =
    "branch,region\n" +
    "north,NE\n" +
    "south,SE\n";

  async function seedLoans(store: WarehouseStore, sessionId = "ses_1"): Promise<void> {
    const path = await fixtureCsv("loans.csv", LOANS_CSV);
    await registerSessionSource(store, { sessionId, name: "loans", path });
  }

  it("queries a CSV source by its name and returns typed columns + rows", async () => {
    const store = await freshStore();
    await seedLoans(store);

    const result = await runQuery(store, {
      sessionId: "ses_1",
      sql: "SELECT loan_id, branch, balance FROM loans ORDER BY loan_id",
    });

    expect(result.columns.map((c) => c.name)).toEqual(["loan_id", "branch", "balance"]);
    // DuckDB infers loan_id as an integer type and balance as a floating type.
    expect(result.columns[1]?.type).toBe("VARCHAR");
    expect(result.rows).toEqual([
      { loan_id: 1, branch: "north", balance: 1000.5 },
      { loan_id: 2, branch: "south", balance: null },
      { loan_id: 3, branch: "north", balance: 750.25 },
    ]);
    expect(result.rowCount).toBe(3);
    expect(result.truncated).toBe(false);
  });

  it("aggregates over a source (GROUP BY) with the correct measures", async () => {
    const store = await freshStore();
    await seedLoans(store);

    const result = await runQuery(store, {
      sessionId: "ses_1",
      sql: "SELECT branch, SUM(COALESCE(balance,0)) AS total FROM loans GROUP BY branch",
    });

    const byBranch = new Map(
      result.rows.map((r) => [String(r.branch), Number(r.total)]),
    );
    expect(byBranch.get("north")).toBe(1750.75);
    expect(byBranch.get("south")).toBe(0);
  });

  it("joins two CSV sources referenced by name", async () => {
    const store = await freshStore();
    await seedLoans(store);
    const branchesPath = await fixtureCsv("branches.csv", BRANCHES_CSV);
    await registerSessionSource(store, {
      sessionId: "ses_1",
      name: "branches",
      path: branchesPath,
    });

    const result = await runQuery(store, {
      sessionId: "ses_1",
      sql:
        "SELECT b.region, COUNT(*) AS loans FROM loans l " +
        "JOIN branches b ON l.branch = b.branch GROUP BY b.region ORDER BY b.region",
    });

    expect(result.rows).toEqual([
      { region: "NE", loans: 2 },
      { region: "SE", loans: 1 },
    ]);
  });

  it("joins a CSV source to an attached (Postgres-style) table by qualified name (V5.3)", async () => {
    const store = await freshStore();
    await seedLoans(store);

    // Model a registered Postgres attached read-only (V5.2): attach a second DuckDB catalog and put
    // a table in it, then register it as a `postgres` session source under its qualified name — the
    // exact shape the attach_source route produces. run_query does NOT build a view for a non-CSV
    // source; the attached catalog table is resolved directly by its qualified name.
    const catalogDir = await mkdtemp(join(tmpdir(), "pg-"));
    tempDirs.push(catalogDir);
    await store.run(`ATTACH '${join(catalogDir, "neon.duckdb")}' AS neon`);
    await store.run("CREATE TABLE neon.main.branches (branch VARCHAR, region VARCHAR)");
    await store.run("INSERT INTO neon.main.branches VALUES ('north','NE'),('south','SE')");
    await registerSessionSource(store, {
      sessionId: "ses_1",
      name: "neon.main.branches",
      kind: "postgres",
      path: "neon.main.branches",
    });

    const result = await runQuery(store, {
      sessionId: "ses_1",
      sql:
        "SELECT b.region, COUNT(*) AS loans FROM loans l " +
        "JOIN neon.main.branches b ON l.branch = b.branch GROUP BY b.region ORDER BY b.region",
    });

    expect(result.rows).toEqual([
      { region: "NE", loans: 2 },
      { region: "SE", loans: 1 },
    ]);

    await store.run("DETACH neon");
  });

  it("scopes source names to the querying session", async () => {
    const store = await freshStore();
    await seedLoans(store, "ses_owner");
    // A different session has no `loans` view, so the name does not resolve.
    await expect(
      runQuery(store, { sessionId: "ses_other", sql: "SELECT * FROM loans" }),
    ).rejects.toThrow();
  });

  it("returns an empty-row result with columns intact for a query that matches nothing", async () => {
    const store = await freshStore();
    await seedLoans(store);
    const result = await runQuery(store, {
      sessionId: "ses_1",
      sql: "SELECT loan_id, branch FROM loans WHERE branch = 'east'",
    });
    expect(result.columns.map((c) => c.name)).toEqual(["loan_id", "branch"]);
    expect(result.rows).toEqual([]);
    expect(result.rowCount).toBe(0);
  });

  it("caps a large result at MAX_QUERY_ROWS and flags truncation", async () => {
    const store = await freshStore();
    await seedLoans(store);
    // range(1200) yields 1200 rows, above the 1000-row cap.
    const result = await runQuery(store, {
      sessionId: "ses_1",
      sql: "SELECT * FROM range(1200) AS t(n)",
    });
    expect(result.rows).toHaveLength(1000);
    expect(result.rowCount).toBe(1000);
    expect(result.truncated).toBe(true);
  });

  it("rejects a non-read-only query before running it", async () => {
    const store = await freshStore();
    await seedLoans(store);
    await expect(
      runQuery(store, { sessionId: "ses_1", sql: "DROP TABLE loans" }),
    ).rejects.toBeInstanceOf(NonReadOnlyQueryError);
    await expect(
      runQuery(store, { sessionId: "ses_1", sql: "SELECT 1; DROP TABLE loans" }),
    ).rejects.toBeInstanceOf(NonReadOnlyQueryError);
  });

  it("propagates a SQL error (unknown column) so the route can 422 it", async () => {
    const store = await freshStore();
    await seedLoans(store);
    await expect(
      runQuery(store, { sessionId: "ses_1", sql: "SELECT nope FROM loans" }),
    ).rejects.toThrow();
  });
});
