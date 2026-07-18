import { describe, expect, it } from "vitest";
import {
  ListedSourceSchema,
  SessionSourceSchema,
  toListedSource,
  type SessionSource,
} from "./session-sources.js";

/**
 * Pure unit tests for the session-source contract (V3.1, FR4/FR5b). The load-bearing assertion
 * is that {@link toListedSource} strips the backend-only `path` — the model must never receive a
 * filesystem path or credential, only a source's name/kind/rowCount.
 */
describe("session-source contract", () => {
  const source: SessionSource = {
    sessionId: "ses_1",
    name: "loans",
    kind: "csv",
    path: "data/uploads/ses_1/abc-loans.csv",
    rowCount: 24,
    createdAt: "2026-07-18 00:00:00",
  };

  it("validates a full session source", () => {
    expect(SessionSourceSchema.parse(source)).toEqual(source);
  });

  it("accepts a null row count (unprofiled) but rejects a negative one", () => {
    expect(SessionSourceSchema.parse({ ...source, rowCount: null }).rowCount).toBeNull();
    expect(() => SessionSourceSchema.parse({ ...source, rowCount: -1 })).toThrow();
  });

  it("rejects an empty name or path", () => {
    expect(() => SessionSourceSchema.parse({ ...source, name: "" })).toThrow();
    expect(() => SessionSourceSchema.parse({ ...source, path: "" })).toThrow();
  });

  it("toListedSource strips the path and keeps only the model-safe fields", () => {
    const listed = toListedSource(source);
    expect(listed).toEqual({ name: "loans", kind: "csv", rowCount: 24 });
    expect(listed).not.toHaveProperty("path");
    expect(listed).not.toHaveProperty("sessionId");
    // The projected view is itself a valid ListedSource.
    expect(ListedSourceSchema.parse(listed)).toEqual(listed);
  });

  it("carries a null row count through the projection", () => {
    expect(toListedSource({ ...source, rowCount: null }).rowCount).toBeNull();
  });
});
