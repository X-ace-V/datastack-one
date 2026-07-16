import { describe, expect, it } from "vitest";
import { createRunApprovalGate, UnknownRunApprovalError } from "./run-approvals.js";
import type { RunApprovalRequest } from "../core/run.js";

/** Unit tests for the deterministic run approval gate (T4.4 / FR8). */
function makeRequest(overrides: Partial<RunApprovalRequest> = {}): RunApprovalRequest {
  return {
    requestID: "req1",
    runId: "run1",
    stepId: "step1",
    stepName: "land",
    tool: "land_parquet",
    summary: "Land the source",
    sql: null,
    args: {},
    ...overrides,
  };
}

describe("createRunApprovalGate", () => {
  it("parks a request until it is resolved, then delivers the human's action", async () => {
    const gate = createRunApprovalGate();
    const request = makeRequest();

    const pending = gate.request(request);
    expect(gate.pending()).toEqual([request]);
    expect(gate.get("req1")).toEqual(request);

    const returned = gate.resolve("req1", "approve");
    expect(returned).toEqual(request);
    await expect(pending).resolves.toBe("approve");
    // Resolving drops it from the queue.
    expect(gate.pending()).toEqual([]);
    expect(gate.get("req1")).toBeUndefined();
  });

  it("delivers a reject action to the parked runner", async () => {
    const gate = createRunApprovalGate();
    const pending = gate.request(makeRequest());
    gate.resolve("req1", "reject");
    await expect(pending).resolves.toBe("reject");
  });

  it("scopes pending() to a run when asked", () => {
    const gate = createRunApprovalGate();
    gate.request(makeRequest({ requestID: "a", runId: "run1" }));
    gate.request(makeRequest({ requestID: "b", runId: "run2" }));
    gate.request(makeRequest({ requestID: "c", runId: "run1" }));

    expect(gate.pending().map((r) => r.requestID)).toEqual(["a", "b", "c"]);
    expect(gate.pending("run1").map((r) => r.requestID)).toEqual(["a", "c"]);
  });

  it("throws UnknownRunApprovalError when resolving an unknown request", () => {
    const gate = createRunApprovalGate();
    expect(() => gate.resolve("nope", "approve")).toThrow(UnknownRunApprovalError);
  });
});
