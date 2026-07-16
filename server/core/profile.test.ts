import { describe, expect, it } from "vitest";
import {
  buildSourceProfile,
  computeNullPercent,
  isCandidateKey,
  isDateType,
  SourceProfileSchema,
  type RawColumnStat,
} from "./profile.js";

/**
 * Unit tests for the pure profile classification (T2.3 / PRD FR2). These assert the desired
 * values — null %, candidate-key and date-column decisions, and the assembled profile shape —
 * independently of DuckDB. The `read_csv_auto` integration is covered in
 * {@link file://../tools/profile.test.ts}.
 */
describe("profile classification (pure)", () => {
  describe("isDateType", () => {
    it.each([
      ["DATE", true],
      ["TIMESTAMP", true],
      ["TIMESTAMP WITH TIME ZONE", true],
      ["TIMESTAMP_NS", true],
      ["TIME", true],
      ["timestamp", true],
      ["BIGINT", false],
      ["VARCHAR", false],
      ["DOUBLE", false],
      ["DECIMAL(18,2)", false],
    ])("classifies %s as date=%s", (type, expected) => {
      expect(isDateType(type)).toBe(expected);
    });
  });

  describe("computeNullPercent", () => {
    it("is the null fraction as a rounded percentage", () => {
      expect(computeNullPercent(1, 4)).toBe(25);
      expect(computeNullPercent(0, 4)).toBe(0);
      expect(computeNullPercent(4, 4)).toBe(100);
      expect(computeNullPercent(1, 3)).toBe(33.33);
    });

    it("is 0 for an empty source (no division by zero)", () => {
      expect(computeNullPercent(0, 0)).toBe(0);
    });
  });

  describe("isCandidateKey", () => {
    it("is true only when non-null and fully distinct", () => {
      expect(isCandidateKey(0, 5, 5)).toBe(true);
    });

    it("is false when any value is null", () => {
      expect(isCandidateKey(1, 4, 5)).toBe(false);
    });

    it("is false when values repeat", () => {
      expect(isCandidateKey(0, 3, 5)).toBe(false);
    });

    it("is false for an empty source", () => {
      expect(isCandidateKey(0, 0, 0)).toBe(false);
    });
  });

  describe("buildSourceProfile", () => {
    const stats: RawColumnStat[] = [
      { name: "id", type: "BIGINT", nullCount: 0, distinctCount: 4 },
      { name: "branch", type: "VARCHAR", nullCount: 1, distinctCount: 2 },
      { name: "opened_at", type: "DATE", nullCount: 0, distinctCount: 4 },
    ];

    it("derives a validated profile with keys and date columns", () => {
      const profile = buildSourceProfile(4, stats);

      // Parses against the schema (all required fields present, ranges hold).
      expect(() => SourceProfileSchema.parse(profile)).not.toThrow();

      expect(profile.rowCount).toBe(4);
      expect(profile.columnCount).toBe(3);
      expect(profile.candidateKeys).toEqual(["id", "opened_at"]);
      expect(profile.dateColumns).toEqual(["opened_at"]);

      const branch = profile.columns.find((c) => c.name === "branch");
      expect(branch).toMatchObject({
        type: "VARCHAR",
        nullCount: 1,
        nullPercent: 25,
        distinctCount: 2,
        isCandidateKey: false,
        isDateColumn: false,
      });
    });

    it("preserves column order and produces one entry per column", () => {
      const profile = buildSourceProfile(4, stats);
      expect(profile.columns.map((c) => c.name)).toEqual([
        "id",
        "branch",
        "opened_at",
      ]);
    });

    it("marks no candidate keys for an empty source", () => {
      const profile = buildSourceProfile(0, [
        { name: "id", type: "BIGINT", nullCount: 0, distinctCount: 0 },
      ]);
      expect(profile.candidateKeys).toEqual([]);
      expect(profile.columns[0]?.nullPercent).toBe(0);
    });
  });
});
