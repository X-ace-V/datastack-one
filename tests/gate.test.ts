import { describe, it, expect } from "vitest";

// Phase 0 gate: proves the test runner, TS/ESM toolchain, and CI gate are wired.
// Real feature tests replace/augment this as tasks land.
describe("phase 0 gate", () => {
  it("runs the vitest suite under ESM + NodeNext", () => {
    expect(1 + 1).toBe(2);
  });
});
