import { describe, expect, it } from "vitest";
import {
  buildCsvExportSql,
  isServingFormat,
  safeServedName,
  servedCsvEndpoint,
  servedCsvFilename,
  servedEndpoint,
  ServedTableSchema,
  DEFAULT_SERVED_NAME,
  DEFAULT_SERVING_FORMAT,
  SERVE_ROUTE_PREFIX,
  SERVING_FORMATS,
} from "./serving.js";

/**
 * Pure-contract tests for the serving layer (T5.2 / PRD FR10): the served-name sanitizer, the
 * endpoint derivation, the exact CSV export SQL the publish stage shows for approval and runs,
 * and the served-table registry row's shape.
 */
describe("serving formats", () => {
  it("offers CSV as the MVP's served artifact and rejects anything else", () => {
    expect(SERVING_FORMATS).toEqual(["csv"]);
    expect(DEFAULT_SERVING_FORMAT).toBe("csv");
    expect(isServingFormat("csv")).toBe(true);
    expect(isServingFormat("parquet")).toBe(false);
    expect(isServingFormat("")).toBe(false);
  });
});

describe("safeServedName", () => {
  it("keeps an already-safe name verbatim", () => {
    expect(safeServedName("branch_balance_totals")).toBe("branch_balance_totals");
    expect(safeServedName("daily-report")).toBe("daily-report");
  });

  it("strips directory components so a name cannot traverse out of the serving dir", () => {
    expect(safeServedName("../../etc/passwd")).toBe("passwd");
    expect(safeServedName("/abs/path/report")).toBe("report");
    expect(safeServedName("a\\b\\report")).toBe("report");
  });

  it("replaces dots, so `/api/serve/:name` and `/api/serve/:name.csv` stay unambiguous", () => {
    // A dot would make the name collide with the `.csv` download route's suffix.
    expect(safeServedName("report.csv")).toBe("report_csv");
    expect(safeServedName("marts.totals")).toBe("marts_totals");
  });

  it("replaces URL- and shell-unsafe characters, keeping only [A-Za-z0-9_-]", () => {
    expect(safeServedName("my report?x=1")).toBe("my_report_x_1");
    // `-` survives (it is URL- and file-safe); everything else in the payload is neutralized.
    expect(safeServedName('x"; DROP TABLE t; --')).toBe("x___DROP_TABLE_t__--");
  });

  it("falls back to the default rather than ever returning an empty name", () => {
    expect(safeServedName("")).toBe(DEFAULT_SERVED_NAME);
    expect(safeServedName("///")).toBe(DEFAULT_SERVED_NAME);
    expect(safeServedName("...")).toBe("___");
  });
});

describe("served endpoints", () => {
  it("derives the REST and CSV endpoints from the served name", () => {
    expect(servedEndpoint("totals")).toBe("/api/serve/totals");
    expect(servedCsvEndpoint("totals")).toBe("/api/serve/totals.csv");
    expect(servedEndpoint("totals").startsWith(SERVE_ROUTE_PREFIX)).toBe(true);
  });

  it("names the CSV export file after the served name", () => {
    expect(servedCsvFilename("totals")).toBe("totals.csv");
  });
});

describe("buildCsvExportSql", () => {
  it("builds a COPY with a header so the download opens as a usable spreadsheet", () => {
    expect(
      buildCsvExportSql({
        schema: "marts",
        table: "branch_balance_totals",
        csvPath: "/tmp/serving/p1/branch_balance_totals.csv",
      }),
    ).toBe(
      `COPY (SELECT * FROM "marts"."branch_balance_totals") ` +
        `TO '/tmp/serving/p1/branch_balance_totals.csv' (FORMAT CSV, HEADER)`,
    );
  });

  it("sanitizes the identifiers, so a crafted table name cannot inject SQL", () => {
    const sql = buildCsvExportSql({
      schema: "marts",
      table: 'totals"; DROP TABLE raw.source; --',
      csvPath: "/tmp/x.csv",
    });
    // The whole crafted name collapses to one quoted identifier — no statement break survives.
    expect(sql).toBe(
      `COPY (SELECT * FROM "marts"."totals___DROP_TABLE_raw_source____") ` +
        `TO '/tmp/x.csv' (FORMAT CSV, HEADER)`,
    );
    expect(sql).not.toContain("DROP TABLE raw.source;");
  });

  it("escapes a single quote in the destination path", () => {
    const sql = buildCsvExportSql({
      schema: "marts",
      table: "t",
      csvPath: "/tmp/o'brien/report.csv",
    });
    expect(sql).toContain(`TO '/tmp/o''brien/report.csv'`);
  });
});

describe("ServedTableSchema", () => {
  const served = {
    name: "branch_balance_totals",
    projectId: "p1",
    runId: "r1",
    schema: "marts",
    table: "branch_balance_totals",
    qualifiedTable: "marts.branch_balance_totals",
    format: "csv",
    rowCount: 2,
    csvPath: "/tmp/serving/p1/branch_balance_totals.csv",
    endpoint: "/api/serve/branch_balance_totals",
    csvEndpoint: "/api/serve/branch_balance_totals.csv",
    publishedAt: "2026-07-17 00:00:00",
  };

  it("accepts a registered served table and allows a null runId", () => {
    expect(ServedTableSchema.parse(served)).toEqual(served);
    expect(ServedTableSchema.parse({ ...served, runId: null }).runId).toBeNull();
  });

  it("pins the served schema to marts — only the transform's output is published", () => {
    expect(() => ServedTableSchema.parse({ ...served, schema: "raw" })).toThrow();
  });

  it("rejects an unsupported format and a nonsensical row count", () => {
    expect(() => ServedTableSchema.parse({ ...served, format: "xml" })).toThrow();
    expect(() => ServedTableSchema.parse({ ...served, rowCount: -1 })).toThrow();
    expect(() => ServedTableSchema.parse({ ...served, rowCount: 1.5 })).toThrow();
  });

  it("requires a name, since the name is the served endpoint's identity", () => {
    expect(() => ServedTableSchema.parse({ ...served, name: "" })).toThrow();
  });
});
