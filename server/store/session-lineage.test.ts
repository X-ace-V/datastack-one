import { afterEach, describe, expect, it } from "vitest";
import { openStore, type WarehouseStore } from "./duckdb.js";
import { listSessionLineage, recordLineageEvent } from "./session-lineage.js";
import { insertSession, deleteSession } from "./sessions.js";

/**
 * Unit tests for the session lineage store (V4.4, FR12). Assert the persisted values and ordering
 * — monotonic gap-free `seq`, detail JSON round-trip, per-session isolation, the null defaults for
 * an event with no tool/status/detail — and that deleting a session purges its lineage. Not merely
 * that the calls don't throw.
 */
describe("session-lineage store", () => {
  const open: WarehouseStore[] = [];

  afterEach(async () => {
    await Promise.all(open.splice(0).map((s) => s.close()));
  });

  async function store(): Promise<WarehouseStore> {
    const s = await openStore(":memory:");
    open.push(s);
    return s;
  }

  it("records an event with a seq of 0 and reads back its fields", async () => {
    const s = await store();
    const event = await recordLineageEvent(s, {
      sessionId: "ses_1",
      kind: "tool_call",
      tool: "land_parquet",
      status: "completed",
      detail: { source: "loans", rowCount: 4 },
    });
    expect(event).toMatchObject({
      sessionId: "ses_1",
      runId: null,
      seq: 0,
      kind: "tool_call",
      tool: "land_parquet",
      status: "completed",
      detail: { source: "loans", rowCount: 4 },
    });
    expect(event.id).toBeTruthy();
    expect(typeof event.createdAt).toBe("string");
  });

  it("assigns monotonic, gap-free seqs within a session", async () => {
    const s = await store();
    await recordLineageEvent(s, { sessionId: "ses_1", kind: "approval", tool: "run_transform", status: "approved" });
    await recordLineageEvent(s, { sessionId: "ses_1", kind: "tool_call", tool: "run_transform", status: "completed" });
    await recordLineageEvent(s, { sessionId: "ses_1", kind: "dq_result", tool: "run_dq_check", status: "passed" });
    const lineage = await listSessionLineage(s, "ses_1");
    expect(lineage.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(lineage.map((e) => e.kind)).toEqual(["approval", "tool_call", "dq_result"]);
  });

  it("scopes seq and reads per session (isolation)", async () => {
    const s = await store();
    await recordLineageEvent(s, { sessionId: "ses_1", kind: "tool_call", tool: "land_parquet", status: "completed" });
    await recordLineageEvent(s, { sessionId: "ses_2", kind: "tool_call", tool: "land_parquet", status: "completed" });
    await recordLineageEvent(s, { sessionId: "ses_1", kind: "tool_call", tool: "load_warehouse", status: "completed" });

    const one = await listSessionLineage(s, "ses_1");
    const two = await listSessionLineage(s, "ses_2");
    expect(one.map((e) => e.seq)).toEqual([0, 1]);
    expect(two.map((e) => e.seq)).toEqual([0]);
    expect(one.map((e) => e.tool)).toEqual(["land_parquet", "load_warehouse"]);
  });

  it("stores null for an event with no tool/status/detail", async () => {
    const s = await store();
    const event = await recordLineageEvent(s, { sessionId: "ses_1", kind: "tool_call" });
    expect(event.tool).toBeNull();
    expect(event.status).toBeNull();
    expect(event.detail).toBeNull();
    expect(event.runId).toBeNull();
  });

  it("round-trips a structured detail payload verbatim", async () => {
    const s = await store();
    const detail = {
      targetTable: "raw.source",
      passed: false,
      results: [
        { name: "row count", passed: true },
        { name: "no nulls in id", passed: false },
      ],
    };
    await recordLineageEvent(s, {
      sessionId: "ses_1",
      kind: "dq_result",
      tool: "run_dq_check",
      status: "failed",
      detail,
    });
    const [event] = await listSessionLineage(s, "ses_1");
    expect(event?.detail).toEqual(detail);
  });

  it("returns an empty trail for a session with no events", async () => {
    const s = await store();
    expect(await listSessionLineage(s, "nobody")).toEqual([]);
  });

  it("purges a session's lineage when the session is deleted", async () => {
    const s = await store();
    await insertSession(s, { id: "ses_1", title: "Loan review" });
    await recordLineageEvent(s, { sessionId: "ses_1", kind: "tool_call", tool: "land_parquet", status: "completed" });
    expect(await listSessionLineage(s, "ses_1")).toHaveLength(1);

    expect(await deleteSession(s, "ses_1")).toBe(true);
    expect(await listSessionLineage(s, "ses_1")).toEqual([]);
  });
});
