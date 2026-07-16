import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openStore, type WarehouseStore } from "../store/duckdb.js";
import { SourceProfileSchema } from "../core/profile.js";
import { profileSource } from "./profile.js";

/**
 * Integration test for the `profile_source` tool (T2.3 / PRD FR2) against a real DuckDB
 * `read_csv_auto` read of a synthetic lending CSV fixture. Asserts the desired result — the
 * inferred schema/types, exact row count, null counts and %, candidate primary keys and date
 * columns — not merely that the call returns. Pure classification is covered in
 * {@link file://../core/profile.test.ts}.
 */
describe("profile_source tool (DuckDB read_csv_auto)", () => {
  const open: WarehouseStore[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(open.splice(0).map((s) => s.close()));
    await Promise.all(
      tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
    );
  });

  /** Write `contents` to a fresh `<tmp>/<name>` and return its path. */
  async function fixtureCsv(name: string, contents: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "profile-"));
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

  // Synthetic lending source: a unique key (loan_id), a non-unique dimension (branch) with a
  // null, a numeric measure (balance) with a null, and a date column (opened_at).
  const LOANS_CSV =
    "loan_id,customer_id,branch,balance,opened_at\n" +
    "1,100,north,1000.50,2024-01-01\n" +
    "2,101,south,,2024-01-02\n" +
    "3,100,north,750.25,2024-02-15\n" +
    "4,102,,500.00,2024-03-10\n";

  it("profiles schema, types, rows, nulls, keys and date columns", async () => {
    const store = await freshStore();
    const path = await fixtureCsv("loans_sample.csv", LOANS_CSV);

    const profile = await profileSource(store, path);

    // Validates against the FR2 contract.
    expect(() => SourceProfileSchema.parse(profile)).not.toThrow();

    expect(profile.rowCount).toBe(4);
    expect(profile.columnCount).toBe(5);
    expect(profile.columns.map((c) => c.name)).toEqual([
      "loan_id",
      "customer_id",
      "branch",
      "balance",
      "opened_at",
    ]);

    // DuckDB infers integer keys as BIGINT, the numeric measure as DOUBLE, the date as DATE.
    const byName = Object.fromEntries(profile.columns.map((c) => [c.name, c]));
    expect(byName.loan_id?.type).toBe("BIGINT");
    expect(byName.balance?.type).toBe("DOUBLE");
    expect(byName.opened_at?.type).toBe("DATE");
    expect(byName.branch?.type).toBe("VARCHAR");

    // Null counts and percentages: balance and branch each have one null of four rows.
    expect(byName.balance?.nullCount).toBe(1);
    expect(byName.balance?.nullPercent).toBe(25);
    expect(byName.branch?.nullCount).toBe(1);
    expect(byName.loan_id?.nullCount).toBe(0);
    expect(byName.loan_id?.nullPercent).toBe(0);

    // loan_id is the only candidate key: unique and non-null. customer_id repeats (100 twice),
    // branch has a null, opened_at happens to be unique here so it is also a candidate key.
    expect(byName.loan_id?.isCandidateKey).toBe(true);
    expect(byName.customer_id?.isCandidateKey).toBe(false);
    expect(byName.branch?.isCandidateKey).toBe(false);
    expect(profile.candidateKeys).toContain("loan_id");
    expect(profile.candidateKeys).not.toContain("customer_id");
    expect(profile.candidateKeys).not.toContain("branch");

    // Date columns are surfaced by type.
    expect(byName.opened_at?.isDateColumn).toBe(true);
    expect(byName.balance?.isDateColumn).toBe(false);
    expect(profile.dateColumns).toEqual(["opened_at"]);
  });

  it("counts distinct non-null values per column", async () => {
    const store = await freshStore();
    const path = await fixtureCsv("loans_sample.csv", LOANS_CSV);

    const profile = await profileSource(store, path);
    const byName = Object.fromEntries(profile.columns.map((c) => [c.name, c]));

    // customer_id: {100,101,102} = 3 distinct across 4 rows.
    expect(byName.customer_id?.distinctCount).toBe(3);
    // branch: {north,south} = 2 distinct (null excluded).
    expect(byName.branch?.distinctCount).toBe(2);
  });

  it("handles a header-only CSV (zero rows, no candidate keys)", async () => {
    const store = await freshStore();
    const path = await fixtureCsv("empty.csv", "id,name\n");

    const profile = await profileSource(store, path);

    expect(profile.rowCount).toBe(0);
    expect(profile.columnCount).toBe(2);
    expect(profile.candidateKeys).toEqual([]);
    expect(profile.columns.every((c) => c.nullPercent === 0)).toBe(true);
  });

  it("quotes column identifiers so a crafted header cannot inject SQL", async () => {
    const store = await freshStore();
    // A header containing a double quote and a SQL-ish fragment must be treated as a plain
    // column name, not executed. read_csv_auto keeps it verbatim; the tool must quote it.
    const path = await fixtureCsv(
      "weird.csv",
      'id,"a"" or 1=1 --"\n1,x\n2,y\n',
    );

    const profile = await profileSource(store, path);

    expect(profile.rowCount).toBe(2);
    expect(profile.columns.map((c) => c.name)).toEqual([
      "id",
      'a" or 1=1 --',
    ]);
    expect(profile.columns[1]?.nullCount).toBe(0);
  });

  it("throws when the CSV path does not exist", async () => {
    const store = await freshStore();
    await expect(
      profileSource(store, join(tmpdir(), "does-not-exist-xyz.csv")),
    ).rejects.toThrow();
  });
});
