import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openStore, type WarehouseStore } from "../server/store/duckdb.js";
import { profileSource } from "../server/tools/profile.js";

/**
 * Contract test for the committed demo fixtures (T6.1): the synthetic lending CSV and the
 * plain-English rules doc that the whole flow — profile → plan → transform → DQ → publish —
 * is demoed and acceptance-tested (T6.2) against.
 *
 * The point of these assertions is not that the files parse. It is that **every rule in
 * `rules.txt` is load-bearing against `loans_sample.csv`**: a fixture where a rule is a no-op
 * would let the pipeline look correct while proving nothing. So each rule gets an assertion
 * that fails if the data stops exercising it — duplicates really exist, `loan_amount` really
 * is non-numeric text, all three `loan_status` branches are really reachable, and the report
 * really has a daily × branch grain.
 *
 * The fixture is also deliberately CLEAN (no nulls): the generated DQ checks must PASS so the
 * run reaches a served output. The DQ-failure-blocks-publish path is covered by the DQ tool
 * and runner tests, which construct their own failing data.
 */
describe("demo fixtures (T6.1)", () => {
  const csvPath = fileURLToPath(new URL("../fixtures/loans_sample.csv", import.meta.url));
  const rulesPath = fileURLToPath(new URL("../fixtures/rules.txt", import.meta.url));

  /** The six columns the demo scenario (PRD_DataStack_One §13 step 3) names, in file order. */
  const DECLARED_COLUMNS = [
    "customer_id",
    "loan_amount",
    "dpd_days",
    "branch",
    "balance",
    "created_at",
  ] as const;

  let store: WarehouseStore;

  beforeAll(async () => {
    store = await openStore(":memory:");
  });

  afterAll(async () => {
    await store.close();
  });

  /** Run `sql` against the fixture CSV (bound as `?`) and return the single result row. */
  async function queryFixture(sql: string): Promise<Record<string, unknown>> {
    const rows = await store.all(sql, [csvPath]);
    const row = rows[0];
    if (!row) throw new Error("fixture query returned no row");
    return row;
  }

  describe("rules.txt", () => {
    it("states the four transformation rules from the product PRD", async () => {
      const rules = await readFile(rulesPath, "utf8");

      expect(rules).toContain("Remove duplicate customers by customer_id.");
      expect(rules).toContain("Convert loan_amount to numeric.");
      expect(rules).toContain("Create a loan_status column:");
      expect(rules).toContain("overdue if dpd_days > 0");
      expect(rules).toContain("active if dpd_days = 0 and balance > 0");
      expect(rules).toContain("closed if balance = 0");
      expect(rules).toContain(
        "Create daily branch-level summary with total active loans and overdue amount.",
      );
    });

    it("is non-empty plain text the rules stage will accept", async () => {
      const rules = await readFile(rulesPath, "utf8");

      // RulesInputSchema trims then requires min(1): a whitespace-only doc is a 400.
      expect(rules.trim().length).toBeGreaterThan(0);
      // Every rule references a column that exists in the CSV, or the SQL can't be generated.
      for (const column of ["customer_id", "loan_amount", "dpd_days", "balance", "branch"]) {
        expect(rules).toContain(column);
      }
    });
  });

  describe("loans_sample.csv profiles to the shape the pipeline needs", () => {
    it("exposes exactly the six declared columns, in order, with the expected types", async () => {
      const profile = await profileSource(store, csvPath);

      expect(profile.columns.map((c) => c.name)).toEqual([...DECLARED_COLUMNS]);
      expect(profile.columnCount).toBe(6);
      expect(profile.rowCount).toBe(24);

      const typeOf = (name: string) => profile.columns.find((c) => c.name === name)?.type;
      expect(typeOf("customer_id")).toBe("VARCHAR");
      expect(typeOf("dpd_days")).toBe("BIGINT");
      expect(typeOf("branch")).toBe("VARCHAR");
      expect(typeOf("balance")).toBe("DOUBLE");
      // created_at must infer as a real temporal type, or the generated freshness DQ check
      // (which requires a date column) has nothing to bind to.
      expect(typeOf("created_at")).toBe("DATE");
      expect(profile.dateColumns).toEqual(["created_at"]);
    });

    it("has no nulls, so the generated DQ checks pass and the run reaches a served output", async () => {
      const profile = await profileSource(store, csvPath);

      for (const column of profile.columns) {
        expect(`${column.name}:${column.nullCount}`).toBe(`${column.name}:0`);
        expect(column.nullPercent).toBe(0);
      }
    });

    it("reports no candidate primary key, because customers hold more than one loan", async () => {
      const profile = await profileSource(store, csvPath);

      // Honest consequence of the fixture: no single column identifies a row. This is what
      // makes "remove duplicate customers by customer_id" genuinely ambiguous, which is the
      // FR6 clarifying-question moment the demo wants.
      expect(profile.candidateKeys).toEqual([]);
    });
  });

  describe("every rule in rules.txt is load-bearing", () => {
    it('"remove duplicate customers" has duplicates to remove', async () => {
      const row = await queryFixture(
        "SELECT count(*) AS rows, count(DISTINCT customer_id) AS customers FROM read_csv_auto(?)",
      );

      const rows = Number(row.rows);
      const customers = Number(row.customers);
      expect(rows).toBe(24);
      expect(customers).toBe(22);
      expect(customers).toBeLessThan(rows);
    });

    it('"convert loan_amount to numeric" is required: no value parses as a number as-is', async () => {
      const row = await queryFixture(
        `SELECT count(*) AS total,
                count(TRY_CAST(loan_amount AS DOUBLE)) AS castable,
                count(TRY_CAST(replace(loan_amount, ',', '') AS DOUBLE)) AS cleaned
         FROM read_csv_auto(?)`,
      );

      // The rule is real work, not a no-op: loan_amount lands as thousands-separated text.
      expect(Number(row.total)).toBe(24);
      expect(Number(row.castable)).toBe(0);
      // ...and the rule is satisfiable: stripping the separator makes every value numeric.
      expect(Number(row.cleaned)).toBe(24);
    });

    it('"loan_status" classifies every row into exactly one of the three branches', async () => {
      const row = await queryFixture(
        `SELECT count(*) AS total,
                count(*) FILTER (WHERE dpd_days > 0) AS overdue,
                count(*) FILTER (WHERE dpd_days = 0 AND balance > 0) AS active,
                count(*) FILTER (WHERE balance = 0) AS closed,
                count(*) FILTER (WHERE dpd_days > 0 AND balance = 0) AS overlap
         FROM read_csv_auto(?)`,
      );

      const overdue = Number(row.overdue);
      const active = Number(row.active);
      const closed = Number(row.closed);

      // All three branches are reachable, so the report exercises each one.
      expect(overdue).toBeGreaterThan(0);
      expect(active).toBeGreaterThan(0);
      expect(closed).toBeGreaterThan(0);

      // The rules list overdue/active/closed as unordered bullets, so an overdue-AND-closed
      // row would be genuinely ambiguous and make the report depend on the model's clause
      // order. The fixture keeps the classification total and disjoint instead.
      expect(Number(row.overlap)).toBe(0);
      expect(overdue + active + closed).toBe(Number(row.total));
    });

    it('"daily branch-level summary" has a real daily x branch grain', async () => {
      const row = await queryFixture(
        `SELECT count(DISTINCT branch) AS branches,
                count(DISTINCT created_at) AS days,
                count(DISTINCT (branch, created_at)) AS groups
         FROM read_csv_auto(?)`,
      );

      // A summary over one branch or one day would prove nothing about grouping.
      expect(Number(row.branches)).toBe(4);
      expect(Number(row.days)).toBe(3);
      expect(Number(row.groups)).toBeGreaterThan(1);
    });

    it("has active loans and overdue balances in more than one branch to summarize", async () => {
      const rows = await store.all(
        `SELECT branch,
                count(*) FILTER (WHERE dpd_days = 0 AND balance > 0) AS active_loans,
                coalesce(sum(balance) FILTER (WHERE dpd_days > 0), 0) AS overdue_amount
         FROM read_csv_auto(?)
         GROUP BY branch`,
        [csvPath],
      );

      // The two measures the rules name ("total active loans", "overdue amount") are both
      // non-zero in at least two branches, so a correct report can't be all zeros/nulls.
      const withActive = rows.filter((r) => Number(r.active_loans) > 0);
      const withOverdue = rows.filter((r) => Number(r.overdue_amount) > 0);
      expect(withActive.length).toBeGreaterThanOrEqual(2);
      expect(withOverdue.length).toBeGreaterThanOrEqual(2);
    });
  });
});
