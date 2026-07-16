import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOAD_SCHEMA,
  DEFAULT_LOAD_TABLE,
  isLoadSchema,
  LOAD_SCHEMAS,
  LoadResultSchema,
  safeTableName,
} from "./warehouse.js";

/**
 * Pure unit tests for the warehouse-load contract (T4.2 / PRD FR5): the allowed-schema guard,
 * the table-name sanitizer, and the result schema. The DuckDB `CREATE TABLE ... AS SELECT`
 * round-trip is exercised in {@link file://../tools/warehouse.test.ts}.
 */
describe("LOAD_SCHEMAS / defaults", () => {
  it("targets raw/staging only — never marts", () => {
    expect(LOAD_SCHEMAS).toEqual(["raw", "staging"]);
    expect((LOAD_SCHEMAS as readonly string[]).includes("marts")).toBe(false);
  });

  it("defaults to the raw.source seam the transform/DQ stages read", () => {
    expect(DEFAULT_LOAD_SCHEMA).toBe("raw");
    expect(DEFAULT_LOAD_TABLE).toBe("source");
  });
});

describe("isLoadSchema", () => {
  it("accepts the allowed load schemas", () => {
    expect(isLoadSchema("raw")).toBe(true);
    expect(isLoadSchema("staging")).toBe(true);
  });

  it("rejects marts and any other schema", () => {
    expect(isLoadSchema("marts")).toBe(false);
    expect(isLoadSchema("platform")).toBe(false);
    expect(isLoadSchema("")).toBe(false);
  });
});

describe("safeTableName", () => {
  it("keeps a clean identifier unchanged", () => {
    expect(safeTableName("source")).toBe("source");
    expect(safeTableName("loans_raw_2026")).toBe("loans_raw_2026");
  });

  it("collapses a schema qualifier or path into a bare identifier", () => {
    // A dotted/qualified name must not smuggle in a different schema — `.` is not identifier-safe.
    expect(safeTableName("staging.source")).toBe("staging_source");
    expect(safeTableName("../raw/x")).toBe("___raw_x");
  });

  it("replaces unsafe characters (incl. injection punctuation) with underscores", () => {
    expect(safeTableName('"; DROP TABLE raw.source; --')).toBe("___DROP_TABLE_raw_source____");
    expect(safeTableName("my table")).toBe("my_table");
  });

  it("replaces every unsafe char (only an empty name falls back to the default)", () => {
    // Non-empty input always yields a non-empty identifier — each bad char becomes `_`.
    expect(safeTableName(".")).toBe("_");
    expect(safeTableName("!!!")).toBe("___");
    // Only a truly empty name has nothing to sanitize, so it takes the default.
    expect(safeTableName("")).toBe(DEFAULT_LOAD_TABLE);
  });
});

describe("LoadResultSchema", () => {
  const valid = {
    schema: "raw" as const,
    table: "source",
    qualifiedTable: "raw.source",
    landingPath: "data/landing/loans",
    rowCount: 4,
  };

  it("accepts a well-formed result", () => {
    expect(LoadResultSchema.parse(valid)).toEqual(valid);
  });

  it("rejects a schema outside the allowed set", () => {
    expect(() => LoadResultSchema.parse({ ...valid, schema: "marts" })).toThrow();
  });

  it("rejects a negative row count", () => {
    expect(() => LoadResultSchema.parse({ ...valid, rowCount: -1 })).toThrow();
  });

  it("rejects an empty table name", () => {
    expect(() => LoadResultSchema.parse({ ...valid, table: "" })).toThrow();
  });
});
