import { describe, expect, it } from "vitest";
import {
  buildCsvExportSql,
  isServingFormat,
  safeServedName,
  sessionScopedServedName,
  servedCsvEndpoint,
  servedCsvFilename,
  servedEndpoint,
  ServedTableSchema,
  DEFAULT_SERVED_NAME,
  DEFAULT_SERVING_FORMAT,
  SERVE_ROUTE_PREFIX,
  SERVING_FORMATS,
  ServedDataSchema,
  ServedQuerySchema,
  toJsonCell,
  SERVED_PAGE_DEFAULT_LIMIT,
  SERVED_PAGE_MAX_LIMIT,
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
  it("scopes chat-owned endpoints so equal report names cannot collide across sessions", () => {
    expect(sessionScopedServedName("ses_alpha", "report")).toBe("ses_alpha-report");
    expect(sessionScopedServedName("ses_beta", "report")).toBe("ses_beta-report");
  });

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

/**
 * Pure-contract tests for the serving *read* layer (T5.3 / PRD FR10): the page query the
 * generated REST endpoint accepts, the JSON-safety coercion every served cell passes through,
 * and the served-data response's shape.
 */
describe("served page query", () => {
  it("defaults to a preview page when the caller asks for nothing", () => {
    expect(ServedQuerySchema.parse({})).toEqual({
      limit: SERVED_PAGE_DEFAULT_LIMIT,
      offset: 0,
    });
  });

  it("coerces the string values a query string actually delivers", () => {
    expect(ServedQuerySchema.parse({ limit: "25", offset: "50" })).toEqual({
      limit: 25,
      offset: 50,
    });
  });

  it("rejects a page that is not a usable number rather than clamping it", () => {
    expect(() => ServedQuerySchema.parse({ limit: "abc" })).toThrow();
    expect(() => ServedQuerySchema.parse({ limit: "0" })).toThrow();
    expect(() => ServedQuerySchema.parse({ limit: "-1" })).toThrow();
    expect(() => ServedQuerySchema.parse({ limit: "1.5" })).toThrow();
    expect(() => ServedQuerySchema.parse({ offset: "-1" })).toThrow();
  });

  it("caps the page size so one request cannot ask for unbounded work", () => {
    expect(ServedQuerySchema.parse({ limit: String(SERVED_PAGE_MAX_LIMIT) }).limit).toBe(
      SERVED_PAGE_MAX_LIMIT,
    );
    expect(() => ServedQuerySchema.parse({ limit: String(SERVED_PAGE_MAX_LIMIT + 1) })).toThrow();
  });
});

describe("toJsonCell", () => {
  it("passes JSON-native values through untouched", () => {
    expect(toJsonCell("north")).toBe("north");
    expect(toJsonCell(1750.75)).toBe(1750.75);
    expect(toJsonCell(0)).toBe(0);
    expect(toJsonCell(false)).toBe(false);
  });

  it("maps absent values to null", () => {
    expect(toJsonCell(null)).toBeNull();
    expect(toJsonCell(undefined)).toBeNull();
  });

  it("converts a DuckDB BIGINT, which JSON.stringify would otherwise throw on", () => {
    expect(toJsonCell(42n)).toBe(42);
    expect(toJsonCell(BigInt(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
    expect(toJsonCell(BigInt(Number.MIN_SAFE_INTEGER))).toBe(Number.MIN_SAFE_INTEGER);
    expect(() => JSON.stringify({ v: toJsonCell(42n) })).not.toThrow();
  });

  it("keeps a bigint beyond the safe range exact by stringifying it, never rounding it", () => {
    const beyond = BigInt(Number.MAX_SAFE_INTEGER) + 2n;
    expect(toJsonCell(beyond)).toBe("9007199254740993");
    // The whole point: Number() would silently answer 9007199254740992 instead.
    expect(toJsonCell(beyond)).not.toBe(Number(beyond));
    expect(toJsonCell(-beyond)).toBe("-9007199254740993");
  });

  it("renders warehouse value objects (DATE/TIMESTAMP/DECIMAL) via their toString", () => {
    // Stand-ins with the shape DuckDB returns: an object whose toString is the faithful text.
    expect(toJsonCell({ toString: () => "2026-07-17" })).toBe("2026-07-17");
    expect(toJsonCell({ toString: () => "1.25" })).toBe("1.25");
  });

  it("renders a Date as an ISO string", () => {
    expect(toJsonCell(new Date("2026-07-17T10:00:00.000Z"))).toBe("2026-07-17T10:00:00.000Z");
  });
});

describe("ServedDataSchema", () => {
  const data = {
    name: "branch_balance_totals",
    schema: "marts",
    table: "branch_balance_totals",
    qualifiedTable: "marts.branch_balance_totals",
    format: "csv",
    endpoint: "/api/serve/branch_balance_totals",
    csvEndpoint: "/api/serve/branch_balance_totals.csv",
    publishedAt: "2026-07-17 00:00:00",
    columns: [
      { name: "branch", type: "VARCHAR" },
      { name: "total_balance", type: "DOUBLE" },
    ],
    rowCount: 2,
    rows: [
      { branch: "north", total_balance: 1750.75 },
      { branch: "south", total_balance: 0 },
    ],
    limit: 100,
    offset: 0,
  };

  it("accepts a served page and allows an empty table", () => {
    expect(ServedDataSchema.parse(data)).toEqual(data);
    expect(ServedDataSchema.parse({ ...data, rowCount: 0, rows: [] }).rows).toEqual([]);
  });

  it("accepts the cell types a served row can carry", () => {
    const rows = [{ s: "x", n: 1.5, b: true, empty: null, big: "9007199254740993" }];
    expect(ServedDataSchema.parse({ ...data, rows }).rows).toEqual(rows);
  });

  it("pins the served schema to marts — only published transform output is queryable", () => {
    expect(() => ServedDataSchema.parse({ ...data, schema: "raw" })).toThrow();
  });

  it("rejects a page whose bounds are nonsense", () => {
    expect(() => ServedDataSchema.parse({ ...data, limit: 0 })).toThrow();
    expect(() => ServedDataSchema.parse({ ...data, offset: -1 })).toThrow();
    expect(() => ServedDataSchema.parse({ ...data, rowCount: -1 })).toThrow();
  });
});
