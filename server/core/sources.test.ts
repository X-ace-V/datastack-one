import { describe, expect, it } from "vitest";
import {
  SourceSchema,
  isCsvFilename,
  safeUploadFilename,
} from "./sources.js";

/**
 * Unit tests for the pure source contract (T2.2, FR2). They assert the desired *decisions*:
 * which filenames count as CSV, how a hostile filename is reduced to a safe basename, and
 * that the source row shape validates the fields the store hands back.
 */
describe("source contract", () => {
  describe("isCsvFilename", () => {
    it("accepts .csv regardless of case or surrounding whitespace", () => {
      expect(isCsvFilename("loans.csv")).toBe(true);
      expect(isCsvFilename("LOANS.CSV")).toBe(true);
      expect(isCsvFilename("  quarter.Csv  ")).toBe(true);
    });

    it("rejects non-CSV extensions", () => {
      expect(isCsvFilename("loans.txt")).toBe(false);
      expect(isCsvFilename("loans.csv.exe")).toBe(false);
      expect(isCsvFilename("loans")).toBe(false);
      expect(isCsvFilename("")).toBe(false);
    });
  });

  describe("safeUploadFilename", () => {
    it("keeps a plain filename intact", () => {
      expect(safeUploadFilename("loans_sample.csv")).toBe("loans_sample.csv");
    });

    it("strips directory components, defeating path traversal", () => {
      expect(safeUploadFilename("../../etc/passwd.csv")).toBe("passwd.csv");
      expect(safeUploadFilename("C:\\Users\\x\\loans.csv")).toBe("loans.csv");
    });

    it("replaces unsafe characters and never returns empty", () => {
      expect(safeUploadFilename("my report (v2).csv")).toBe("my_report__v2_.csv");
      expect(safeUploadFilename("/")).toBe("upload.csv");
      expect(safeUploadFilename("")).toBe("upload.csv");
    });
  });

  describe("SourceSchema", () => {
    it("validates a persisted source with nullable optionals", () => {
      const source = SourceSchema.parse({
        id: "s-1",
        projectId: "p-1",
        kind: "csv",
        path: "data/uploads/p-1/s-1-loans.csv",
        originalFilename: "loans.csv",
        rowCount: null,
        createdAt: "2026-07-17 00:00:00",
      });
      expect(source.rowCount).toBeNull();
      expect(source.kind).toBe("csv");
    });

    it("rejects a negative or fractional row count", () => {
      const base = {
        id: "s-1",
        projectId: "p-1",
        kind: "csv",
        path: "p",
        originalFilename: null,
        createdAt: "2026-07-17",
      };
      expect(SourceSchema.safeParse({ ...base, rowCount: -1 }).success).toBe(false);
      expect(SourceSchema.safeParse({ ...base, rowCount: 1.5 }).success).toBe(false);
      expect(SourceSchema.safeParse({ ...base, rowCount: 42 }).success).toBe(true);
    });
  });
});
