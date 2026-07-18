import { describe, expect, it } from "vitest";
import { createSessionDqGate } from "./session-dq.js";
import { DqRunResultSchema, type DqRunResult } from "../core/dq.js";

/**
 * Unit tests for the per-session DQ gate (V4.3, FR9). The gate decides whether a session may
 * publish based on its most recent DQ run: a failing run blocks, a later passing run unblocks,
 * and a session that never ran a check is never blocked.
 */
describe("session DQ gate", () => {
  /** A schema-valid DQ run with the given aggregate outcome (three checks, one per type). */
  function run(passed: boolean, failedName = "loan_id not null"): DqRunResult {
    return DqRunResultSchema.parse({
      targetTable: "raw.source",
      results: [
        { name: "has rows", type: "row_count", column: null, passed: true, detail: "5 row(s)" },
        {
          name: failedName,
          type: "not_null",
          column: "loan_id",
          passed,
          detail: passed ? "no NULLs in loan_id" : "2 NULL(s) in loan_id",
        },
        {
          name: "opened_at fresh",
          type: "freshness",
          column: "opened_at",
          passed: true,
          detail: "5 non-null value(s) in opened_at",
        },
      ],
      passed,
    });
  }

  it("does not block a session that has never run a check (FR9 blocks a FAILED check)", () => {
    const gate = createSessionDqGate();
    expect(gate.isPublishBlocked("s1")).toBe(false);
    expect(gate.latest("s1")).toBeUndefined();
  });

  it("does not block after a passing run", () => {
    const gate = createSessionDqGate();
    gate.record("s1", run(true));
    expect(gate.isPublishBlocked("s1")).toBe(false);
    expect(gate.latest("s1")?.passed).toBe(true);
  });

  it("blocks after a failing run", () => {
    const gate = createSessionDqGate();
    gate.record("s1", run(false));
    expect(gate.isPublishBlocked("s1")).toBe(true);
    expect(gate.latest("s1")?.passed).toBe(false);
  });

  it("unblocks when a later run passes (latest wins, not a permanent strike)", () => {
    const gate = createSessionDqGate();
    gate.record("s1", run(false));
    expect(gate.isPublishBlocked("s1")).toBe(true);
    gate.record("s1", run(true));
    expect(gate.isPublishBlocked("s1")).toBe(false);
  });

  it("re-blocks if a later run fails again", () => {
    const gate = createSessionDqGate();
    gate.record("s1", run(true));
    gate.record("s1", run(false));
    expect(gate.isPublishBlocked("s1")).toBe(true);
  });

  it("scopes the block per session — one session's failure never blocks another", () => {
    const gate = createSessionDqGate();
    gate.record("s1", run(false));
    gate.record("s2", run(true));
    expect(gate.isPublishBlocked("s1")).toBe(true);
    expect(gate.isPublishBlocked("s2")).toBe(false);
  });
});
