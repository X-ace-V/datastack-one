import { describe, expect, it } from "vitest";
import { createToolApprovalGate } from "./tool-approvals.js";
import { UnknownApprovalError } from "./approvals.js";
import type { NormalizedEvent } from "../core/events.js";

/**
 * Unit tests for the write-tool approval gate (V4.1, FR8/FR10). It is the backend pause point for
 * the custom write tools (OpenCode does not gate plugin tools). We assert the desired behavior:
 * a request surfaces an inline `approval` event and blocks until answered; approve/reject resolve
 * the awaiting promise with the right status and emit `approval_resolved`; an unknown reply throws;
 * and a blanket "always" is never possible (the action set is approve/reject only).
 */
describe("createToolApprovalGate", () => {
  function setup() {
    const emitted: NormalizedEvent[] = [];
    const gate = createToolApprovalGate((e) => emitted.push(e));
    return { gate, emitted };
  }

  it("surfaces an inline approval carrying the tool + review metadata, and stays pending", () => {
    const { gate, emitted } = setup();
    const { request } = gate.request({
      sessionID: "ses_1",
      tool: "run_transform",
      metadata: { sql: "CREATE OR REPLACE TABLE marts.x AS SELECT 1", targetTable: "x" },
    });

    // The pending request names the gated tool and carries the exact SQL for review.
    expect(request.type).toBe("run_transform");
    expect(request.sessionID).toBe("ses_1");
    expect(request.metadata.sql).toContain("marts.x");
    expect(gate.get(request.requestID)).toEqual(request);
    expect(gate.pending()).toEqual([request]);

    // It surfaced exactly one inline `approval` event on the chat stream (FR10) — and no resolution.
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ kind: "approval", type: "run_transform", sessionID: "ses_1" });
  });

  it("resolves the awaiting promise as approved and clears the pill", async () => {
    const { gate, emitted } = setup();
    const { request, decided } = gate.request({
      sessionID: "ses_1",
      tool: "land_parquet",
      metadata: { source: "loans" },
    });

    const result = gate.reply(request.requestID, "approve");
    expect(result).toEqual({
      requestID: request.requestID,
      action: "approve",
      type: "land_parquet",
      status: "approved",
    });
    await expect(decided).resolves.toEqual(result);

    // The request drained, and a resolution event cleared the inline pill.
    expect(gate.get(request.requestID)).toBeUndefined();
    expect(gate.pending()).toEqual([]);
    expect(emitted.at(-1)).toEqual({
      kind: "approval_resolved",
      sessionID: "ses_1",
      requestID: request.requestID,
      status: "approved",
    });
  });

  it("resolves as rejected on reject", async () => {
    const { gate } = setup();
    const { request, decided } = gate.request({
      sessionID: "ses_2",
      tool: "publish_serving",
      metadata: { table: "report" },
    });
    const result = gate.reply(request.requestID, "reject");
    expect(result.status).toBe("rejected");
    await expect(decided).resolves.toMatchObject({ status: "rejected" });
  });

  it("throws UnknownApprovalError replying to an unknown or already-answered request", () => {
    const { gate } = setup();
    const { request } = gate.request({
      sessionID: "ses_1",
      tool: "load_warehouse",
      metadata: { dataset: "loans" },
    });
    expect(() => gate.reply("nope", "approve")).toThrow(UnknownApprovalError);
    gate.reply(request.requestID, "approve");
    // A second reply to the same request now fails — it is no longer pending (approved once, FR8).
    expect(() => gate.reply(request.requestID, "approve")).toThrow(UnknownApprovalError);
  });

  it("keeps distinct requests independent and oldest-first", () => {
    const { gate } = setup();
    const a = gate.request({ sessionID: "s", tool: "land_parquet", metadata: {} });
    const b = gate.request({ sessionID: "s", tool: "run_transform", metadata: {} });
    expect(gate.pending().map((r) => r.type)).toEqual(["land_parquet", "run_transform"]);
    expect(a.request.requestID).not.toBe(b.request.requestID);
    gate.reply(a.request.requestID, "approve");
    expect(gate.pending().map((r) => r.type)).toEqual(["run_transform"]);
  });
});
