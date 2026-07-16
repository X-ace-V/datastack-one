import { describe, expect, it } from "vitest";
import {
  formatIngestionDate,
  isIngestionDate,
  safeDatasetName,
  DEFAULT_LANDING_DATASET,
  LandResultSchema,
} from "./landing.js";

/**
 * Pure unit tests for the landing contract (T4.1 / PRD FR4): the dataset-name sanitizer, the
 * UTC ingestion-date formatter, the date guard, and the result schema. The DuckDB `COPY`
 * round-trip is exercised in {@link file://../tools/land.test.ts}.
 */
describe("safeDatasetName", () => {
  it("keeps a clean name unchanged", () => {
    expect(safeDatasetName("loans")).toBe("loans");
    expect(safeDatasetName("loans_2024.v1")).toBe("loans_2024.v1");
  });

  it("drops directory components so a traversal name cannot escape the root", () => {
    expect(safeDatasetName("../../etc/passwd")).toBe("passwd");
    expect(safeDatasetName("/abs/path/loans")).toBe("loans");
    expect(safeDatasetName("a\\b\\loans")).toBe("loans");
  });

  it("replaces unsafe characters with underscores", () => {
    expect(safeDatasetName("loan data!")).toBe("loan_data_");
    expect(safeDatasetName("drop; table")).toBe("drop__table");
  });

  it("falls back to the default when the name sanitizes to nothing", () => {
    expect(safeDatasetName("")).toBe(DEFAULT_LANDING_DATASET);
    expect(safeDatasetName("/")).toBe(DEFAULT_LANDING_DATASET);
    expect(safeDatasetName("../")).toBe(DEFAULT_LANDING_DATASET);
  });
});

describe("formatIngestionDate", () => {
  it("formats an instant as YYYY-MM-DD in UTC", () => {
    expect(formatIngestionDate(new Date("2026-07-17T13:45:00Z"))).toBe("2026-07-17");
  });

  it("uses the UTC calendar day regardless of local offset in the instant", () => {
    // 23:30 UTC is still the 17th in UTC even though it is the 18th in +02:00.
    expect(formatIngestionDate(new Date("2026-07-17T23:30:00Z"))).toBe("2026-07-17");
  });

  it("produces a value that passes its own format guard", () => {
    expect(isIngestionDate(formatIngestionDate(new Date("2026-01-05T00:00:00Z")))).toBe(true);
  });
});

describe("isIngestionDate", () => {
  it("accepts a well-formed YYYY-MM-DD", () => {
    expect(isIngestionDate("2026-07-17")).toBe(true);
  });

  it("rejects malformed or partial dates", () => {
    expect(isIngestionDate("2026-7-1")).toBe(false);
    expect(isIngestionDate("07/17/2026")).toBe(false);
    expect(isIngestionDate("2026-07-17T00:00:00Z")).toBe(false);
    expect(isIngestionDate("")).toBe(false);
  });
});

describe("LandResultSchema", () => {
  const valid = {
    dataset: "loans",
    landingPath: "data/landing/loans",
    ingestionDate: "2026-07-17",
    partitionPath: "data/landing/loans/ingestion_date=2026-07-17",
    rowCount: 4,
  };

  it("accepts a well-formed result", () => {
    expect(LandResultSchema.parse(valid)).toEqual(valid);
  });

  it("rejects a malformed ingestion date", () => {
    expect(() => LandResultSchema.parse({ ...valid, ingestionDate: "2026/07/17" })).toThrow();
  });

  it("rejects a negative row count", () => {
    expect(() => LandResultSchema.parse({ ...valid, rowCount: -1 })).toThrow();
  });
});
