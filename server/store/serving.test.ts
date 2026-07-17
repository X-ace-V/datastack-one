import { afterEach, describe, expect, it } from "vitest";
import { openStore, type WarehouseStore } from "./duckdb.js";
import { getServedTable, listServedTables, registerServedTable } from "./serving.js";

/**
 * Unit tests for the served-table registry (T5.2 / PRD FR10/FR12) against a real in-memory
 * warehouse. They assert the registry's core invariant — one row per served name, since the name
 * is an endpoint URL — plus the derived endpoints, the row-count coercion off DuckDB's BIGINT,
 * and that a crafted name is stored literally rather than interpreted as SQL.
 */
describe("served-table registry", () => {
  const open: WarehouseStore[] = [];

  afterEach(async () => {
    await Promise.all(open.splice(0).map((s) => s.close()));
  });

  async function store(): Promise<WarehouseStore> {
    const s = await openStore(":memory:");
    open.push(s);
    return s;
  }

  it("registers a served table and reads it back with derived endpoints", async () => {
    const s = await store();
    const served = await registerServedTable(s, {
      name: "branch_totals",
      projectId: "p1",
      runId: "r1",
      table: "branch_totals",
      format: "csv",
      rowCount: 2,
      csvPath: "/tmp/serving/p1/branch_totals.csv",
    });

    expect(served).toEqual({
      name: "branch_totals",
      projectId: "p1",
      runId: "r1",
      schema: "marts",
      table: "branch_totals",
      qualifiedTable: "marts.branch_totals",
      format: "csv",
      rowCount: 2,
      csvPath: "/tmp/serving/p1/branch_totals.csv",
      endpoint: "/api/serve/branch_totals",
      csvEndpoint: "/api/serve/branch_totals.csv",
      publishedAt: expect.any(String),
    });
    expect(await getServedTable(s, "branch_totals")).toEqual(served);
  });

  it("keeps exactly one row per served name, the newest publish winning", async () => {
    const s = await store();
    await registerServedTable(s, {
      name: "totals",
      projectId: "p1",
      runId: "r1",
      table: "old_table",
      format: "csv",
      rowCount: 2,
      csvPath: "/tmp/a.csv",
    });
    const second = await registerServedTable(s, {
      name: "totals",
      projectId: "p2",
      runId: "r2",
      table: "new_table",
      format: "csv",
      rowCount: 7,
      csvPath: "/tmp/b.csv",
    });

    const rows = await s.all(`SELECT count(*)::BIGINT AS n FROM platform.served_tables`);
    expect(Number(rows[0]?.n)).toBe(1);
    // The endpoint resolves to the newest publish — every field replaced, no field left stale.
    expect(second).toMatchObject({
      projectId: "p2",
      runId: "r2",
      table: "new_table",
      qualifiedTable: "marts.new_table",
      rowCount: 7,
      csvPath: "/tmp/b.csv",
    });
    expect(await getServedTable(s, "totals")).toEqual(second);
  });

  it("allows a null runId for a publish made outside a run", async () => {
    const s = await store();
    const served = await registerServedTable(s, {
      name: "manual",
      projectId: "p1",
      table: "manual",
      format: "csv",
      rowCount: 0,
      csvPath: "/tmp/manual.csv",
    });
    expect(served.runId).toBeNull();
    expect(served.rowCount).toBe(0);
  });

  it("returns null for a name that was never published", async () => {
    const s = await store();
    expect(await getServedTable(s, "nope")).toBeNull();
  });

  it("lists a project's served tables, newest publish first", async () => {
    const s = await store();
    await registerServedTable(s, {
      name: "older_report",
      projectId: "p1",
      runId: "r1",
      table: "older_report",
      format: "csv",
      rowCount: 3,
      csvPath: "/tmp/older.csv",
    });
    // published_at is stamped by now(); force a distinct, later timestamp so the ordering the
    // Serve page relies on is asserted deterministically rather than racing the clock.
    await s.run(
      `UPDATE platform.served_tables SET published_at = TIMESTAMP '2026-07-17 09:00:00'
       WHERE name = 'older_report'`,
    );
    await registerServedTable(s, {
      name: "newer_report",
      projectId: "p1",
      runId: "r2",
      table: "newer_report",
      format: "csv",
      rowCount: 5,
      csvPath: "/tmp/newer.csv",
    });
    await s.run(
      `UPDATE platform.served_tables SET published_at = TIMESTAMP '2026-07-17 10:00:00'
       WHERE name = 'newer_report'`,
    );

    const listed = await listServedTables(s, "p1");

    expect(listed.map((t) => t.name)).toEqual(["newer_report", "older_report"]);
    expect(listed[0]).toMatchObject({
      name: "newer_report",
      rowCount: 5,
      endpoint: "/api/serve/newer_report",
      csvEndpoint: "/api/serve/newer_report.csv",
    });
  });

  it("scopes the listing to one project and returns none for a project that never published", async () => {
    const s = await store();
    await registerServedTable(s, {
      name: "p1_report",
      projectId: "p1",
      table: "p1_report",
      format: "csv",
      rowCount: 1,
      csvPath: "/tmp/p1.csv",
    });
    await registerServedTable(s, {
      name: "p2_report",
      projectId: "p2",
      table: "p2_report",
      format: "csv",
      rowCount: 1,
      csvPath: "/tmp/p2.csv",
    });

    // Another project's endpoints never leak into this project's Serve page.
    expect((await listServedTables(s, "p1")).map((t) => t.name)).toEqual(["p1_report"]);
    expect((await listServedTables(s, "p2")).map((t) => t.name)).toEqual(["p2_report"]);
    expect(await listServedTables(s, "never-published")).toEqual([]);
  });

  it("binds the name as a parameter, storing an injection payload literally", async () => {
    const s = await store();
    const payload = "totals'; DROP TABLE platform.served_tables; --";
    await registerServedTable(s, {
      name: payload,
      projectId: "p1",
      table: "t",
      format: "csv",
      rowCount: 1,
      csvPath: "/tmp/x.csv",
    });

    // The table still exists and holds the payload verbatim as a name — it was never executed.
    const found = await getServedTable(s, payload);
    expect(found?.name).toBe(payload);
  });
});
