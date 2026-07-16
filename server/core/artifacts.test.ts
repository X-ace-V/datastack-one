import { describe, expect, it } from "vitest";
import {
  ARTIFACT_KINDS,
  ArtifactSchema,
  DEFAULT_ARTIFACT_FILENAME,
  RulesInputSchema,
  safeArtifactFilename,
} from "./artifacts.js";

/**
 * Unit tests for the pure artifact contract (T3.1, FR6). They assert the desired classification
 * and validation behavior — the traversal-safe filename sanitizer, the kind enum the schema
 * enforces, and the rules-input rejection of empty/whitespace submissions — in isolation, no I/O.
 */
describe("safeArtifactFilename", () => {
  it("strips directory components to defeat traversal", () => {
    expect(safeArtifactFilename("../../etc/passwd")).toBe("passwd");
    expect(safeArtifactFilename("/abs/path/plan.sql")).toBe("plan.sql");
    expect(safeArtifactFilename("a\\b\\rules.txt")).toBe("rules.txt");
  });

  it("replaces unsafe characters with underscores", () => {
    expect(safeArtifactFilename("my rules!.txt")).toBe("my_rules_.txt");
    expect(safeArtifactFilename("plan (v2).sql")).toBe("plan__v2_.sql");
  });

  it("keeps safe names verbatim", () => {
    expect(safeArtifactFilename("transform_v1.sql")).toBe("transform_v1.sql");
  });

  it("falls back to a default when the name sanitizes to nothing", () => {
    expect(safeArtifactFilename("../")).toBe(DEFAULT_ARTIFACT_FILENAME);
    expect(safeArtifactFilename("")).toBe(DEFAULT_ARTIFACT_FILENAME);
    expect(safeArtifactFilename("///")).toBe(DEFAULT_ARTIFACT_FILENAME);
  });
});

describe("ArtifactSchema", () => {
  const base = {
    id: "a-1",
    projectId: "p-1",
    runId: null,
    kind: "rules" as const,
    path: "data/artifacts/p-1/a-1-rules.txt",
    content: "keep only active loans",
    createdAt: "2026-07-17 00:00:00",
  };

  it("accepts a valid artifact for every declared kind", () => {
    for (const kind of ARTIFACT_KINDS) {
      expect(ArtifactSchema.parse({ ...base, kind }).kind).toBe(kind);
    }
  });

  it("allows null runId, path and content", () => {
    const parsed = ArtifactSchema.parse({
      ...base,
      runId: null,
      path: null,
      content: null,
    });
    expect(parsed.path).toBeNull();
    expect(parsed.content).toBeNull();
  });

  it("rejects an unknown kind", () => {
    expect(ArtifactSchema.safeParse({ ...base, kind: "nonsense" }).success).toBe(false);
  });
});

describe("RulesInputSchema", () => {
  it("accepts non-empty rules text (trimmed)", () => {
    const parsed = RulesInputSchema.parse({ rules: "  drop rows where dpd_days > 90  " });
    expect(parsed.rules).toBe("drop rows where dpd_days > 90");
  });

  it("rejects a whitespace-only submission", () => {
    expect(RulesInputSchema.safeParse({ rules: "   \n\t " }).success).toBe(false);
  });

  it("rejects a missing rules field", () => {
    expect(RulesInputSchema.safeParse({}).success).toBe(false);
  });
});
