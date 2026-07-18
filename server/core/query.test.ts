import { describe, expect, it } from "vitest";
import {
  assertReadOnlySelect,
  buildQueryResult,
  MAX_QUERY_ROWS,
  NonReadOnlyQueryError,
  QueryResultSchema,
  stripStringsAndComments,
} from "./query.js";

/**
 * Pure unit tests for the `run_query` contract (V3.3, FR7): the read-only guard, the literal/comment
 * stripper it rests on, the row-cap + result assembly, and the result schema. The DuckDB execution
 * is covered by `server/tools/query.test.ts`; these assert the classification without any I/O.
 */
describe("stripStringsAndComments", () => {
  it("collapses string literals so their contents can't fool the structural checks", () => {
    expect(stripStringsAndComments("SELECT 'a;b' AS x").includes(";")).toBe(false);
    expect(stripStringsAndComments('SELECT "co;l" FROM t').includes(";")).toBe(false);
  });

  it("keeps a doubled quote inside a literal from ending it early", () => {
    // 'it''s; here' is ONE literal — the inner ;/text must not survive as structure.
    expect(stripStringsAndComments("SELECT 'it''s; here' AS x").includes(";")).toBe(false);
  });

  it("removes line and block comments", () => {
    expect(stripStringsAndComments("SELECT 1 -- ; DROP\n, 2").includes(";")).toBe(false);
    expect(stripStringsAndComments("SELECT /* ; DROP */ 1").includes(";")).toBe(false);
  });
});

describe("assertReadOnlySelect", () => {
  it("accepts a plain SELECT and strips a trailing semicolon", () => {
    expect(assertReadOnlySelect("SELECT * FROM loans")).toBe("SELECT * FROM loans");
    expect(assertReadOnlySelect("SELECT 1;")).toBe("SELECT 1");
    expect(assertReadOnlySelect("  select 1  ")).toBe("select 1");
  });

  it("accepts a WITH ... SELECT (CTE) query", () => {
    const sql = "WITH t AS (SELECT 1 AS n) SELECT n FROM t";
    expect(assertReadOnlySelect(sql)).toBe(sql);
  });

  it("accepts a leading comment before the SELECT", () => {
    const sql = "-- pick everything\nSELECT * FROM loans";
    expect(assertReadOnlySelect(sql)).toBe(sql);
  });

  it("keeps SELECT clauses that merely contain forbidden-looking words", () => {
    // OFFSET/ORDER and a column named update_time must not be mistaken for write keywords.
    const sql = "SELECT update_time FROM loans ORDER BY id LIMIT 5 OFFSET 2";
    expect(assertReadOnlySelect(sql)).toBe(sql);
    // A string literal that mentions a write verb is data, not a statement.
    const withLiteral = "SELECT * FROM loans WHERE note = 'please delete me'";
    expect(assertReadOnlySelect(withLiteral)).toBe(withLiteral);
  });

  it("rejects an empty or whitespace-only query", () => {
    expect(() => assertReadOnlySelect("")).toThrow(NonReadOnlyQueryError);
    expect(() => assertReadOnlySelect("   ")).toThrow(NonReadOnlyQueryError);
  });

  it("rejects a non-SELECT statement", () => {
    for (const sql of [
      "DROP TABLE loans",
      "DELETE FROM loans",
      "INSERT INTO loans VALUES (1)",
      "UPDATE loans SET x = 1",
      "CREATE TABLE t AS SELECT 1",
      "ATTACH 'x.db' AS x",
      "COPY loans TO 'x.csv'",
      "PRAGMA database_list",
    ]) {
      expect(() => assertReadOnlySelect(sql), sql).toThrow(NonReadOnlyQueryError);
    }
  });

  it("rejects a second statement smuggled after a SELECT", () => {
    expect(() => assertReadOnlySelect("SELECT 1; DROP TABLE loans")).toThrow(
      NonReadOnlyQueryError,
    );
  });
});

describe("buildQueryResult", () => {
  const columns = [
    { name: "branch", type: "VARCHAR" },
    { name: "total", type: "DOUBLE" },
  ];

  it("assembles rows column-by-column and coerces cells to JSON-safe values", () => {
    const result = buildQueryResult(columns, [
      { branch: "north", total: 1750.75 },
      { branch: "south", total: 0 },
    ]);
    expect(result.columns).toEqual(columns);
    expect(result.rows).toEqual([
      { branch: "north", total: 1750.75 },
      { branch: "south", total: 0 },
    ]);
    expect(result.rowCount).toBe(2);
    expect(result.truncated).toBe(false);
  });

  it("coerces a bigint cell to a number within the safe range", () => {
    const result = buildQueryResult([{ name: "n", type: "BIGINT" }], [{ n: 42n }]);
    expect(result.rows[0]).toEqual({ n: 42 });
  });

  it("uses the described columns even when a row is missing a key (0-row shape stays honest)", () => {
    const result = buildQueryResult(columns, []);
    expect(result.columns).toEqual(columns);
    expect(result.rows).toEqual([]);
    expect(result.rowCount).toBe(0);
  });

  it("caps rows at MAX_QUERY_ROWS and flags truncation", () => {
    const raw = Array.from({ length: MAX_QUERY_ROWS + 5 }, (_, i) => ({
      branch: `b${i}`,
      total: i,
    }));
    const result = buildQueryResult(columns, raw);
    expect(result.rows).toHaveLength(MAX_QUERY_ROWS);
    expect(result.rowCount).toBe(MAX_QUERY_ROWS);
    expect(result.truncated).toBe(true);
  });
});

describe("QueryResultSchema", () => {
  it("accepts a well-formed result", () => {
    const value = {
      columns: [{ name: "x", type: "INTEGER" }],
      rows: [{ x: 1 }],
      rowCount: 1,
      truncated: false,
    };
    expect(QueryResultSchema.parse(value)).toEqual(value);
  });

  it("rejects a non-JSON cell value", () => {
    expect(() =>
      QueryResultSchema.parse({
        columns: [{ name: "x", type: "INTEGER" }],
        rows: [{ x: { nested: true } }],
        rowCount: 1,
        truncated: false,
      }),
    ).toThrow();
  });
});
