import { describe, expect, it } from "vitest";
import {
  ListSourcesRequestSchema,
  ListSourcesResponseSchema,
  ProfileSourceRequestSchema,
  ProfileSourceResponseSchema,
} from "./tool-io.js";

/**
 * Pure unit tests for the loopback tool-IO contracts (V3.1). These are the wire shapes the
 * agent's plugin and the backend agree on; the routes 400 on a body that fails them, so the
 * accept/reject cases here mirror those route branches.
 */
describe("tool loopback contracts", () => {
  it("requires a non-empty sessionID on list_sources", () => {
    expect(ListSourcesRequestSchema.parse({ sessionID: "ses_1" })).toEqual({
      sessionID: "ses_1",
    });
    expect(() => ListSourcesRequestSchema.parse({})).toThrow();
    expect(() => ListSourcesRequestSchema.parse({ sessionID: "" })).toThrow();
  });

  it("accepts a list of model-safe sources and rejects one carrying a path", () => {
    const ok = ListSourcesResponseSchema.parse({
      sources: [{ name: "loans", kind: "csv", rowCount: 24 }],
    });
    expect(ok.sources).toHaveLength(1);
    // Extra keys (a leaked path) are stripped by the schema, never surfaced.
    const stripped = ListSourcesResponseSchema.parse({
      sources: [{ name: "loans", kind: "csv", rowCount: null, path: "/secret" }],
    });
    expect(stripped.sources[0]).not.toHaveProperty("path");
  });

  it("requires both sessionID and source on profile_source", () => {
    expect(
      ProfileSourceRequestSchema.parse({ sessionID: "ses_1", source: "loans" }),
    ).toEqual({ sessionID: "ses_1", source: "loans" });
    expect(() => ProfileSourceRequestSchema.parse({ sessionID: "ses_1" })).toThrow();
    expect(() =>
      ProfileSourceRequestSchema.parse({ sessionID: "ses_1", source: "" }),
    ).toThrow();
  });

  it("validates a profile response against the source profile schema", () => {
    const profile = {
      rowCount: 2,
      columnCount: 1,
      columns: [
        {
          name: "id",
          type: "BIGINT",
          nullCount: 0,
          nullPercent: 0,
          distinctCount: 2,
          isCandidateKey: true,
          isDateColumn: false,
        },
      ],
      candidateKeys: ["id"],
      dateColumns: [],
    };
    const parsed = ProfileSourceResponseSchema.parse({ source: "loans", profile });
    expect(parsed.source).toBe("loans");
    expect(parsed.profile.rowCount).toBe(2);
    // A malformed profile (missing rowCount) is rejected.
    expect(() =>
      ProfileSourceResponseSchema.parse({ source: "loans", profile: { columns: [] } }),
    ).toThrow();
  });
});
