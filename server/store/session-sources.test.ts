import { afterEach, describe, expect, it } from "vitest";
import { openStore, type WarehouseStore } from "./duckdb.js";
import {
  getSessionSource,
  listSessionSources,
  registerSessionSource,
} from "./session-sources.js";

/**
 * Unit tests for the session-source store (V3.1, FR4). They assert the desired persisted values
 * — the `csv` kind default, the null row count before profiling, newest-first per-session
 * ordering, session isolation, and the (session_id, name) upsert replacing a row in place — not
 * merely that the calls don't throw.
 */
describe("session-source store", () => {
  const open: WarehouseStore[] = [];

  afterEach(async () => {
    await Promise.all(open.splice(0).map((s) => s.close()));
  });

  async function store(): Promise<WarehouseStore> {
    const s = await openStore(":memory:");
    open.push(s);
    return s;
  }

  it("registers a source with the csv default and a null row count", async () => {
    const s = await store();
    const source = await registerSessionSource(s, {
      sessionId: "ses_1",
      name: "loans",
      path: "data/uploads/ses_1/abc-loans.csv",
    });
    expect(source).toMatchObject({
      sessionId: "ses_1",
      name: "loans",
      kind: "csv",
      path: "data/uploads/ses_1/abc-loans.csv",
      rowCount: null,
    });
    expect(source.createdAt).toBeTypeOf("string");
  });

  it("reads a source back by (session, name) and returns null for an unknown name", async () => {
    const s = await store();
    await registerSessionSource(s, {
      sessionId: "ses_1",
      name: "loans",
      path: "/tmp/loans.csv",
      rowCount: 24,
    });
    const found = await getSessionSource(s, "ses_1", "loans");
    expect(found?.rowCount).toBe(24);
    expect(await getSessionSource(s, "ses_1", "nope")).toBeNull();
    // Same name, different session → not found (session isolation).
    expect(await getSessionSource(s, "ses_2", "loans")).toBeNull();
  });

  it("lists a session's sources newest-first and does not bleed across sessions", async () => {
    const s = await store();
    await registerSessionSource(s, { sessionId: "ses_1", name: "a", path: "/tmp/a.csv" });
    await registerSessionSource(s, { sessionId: "ses_1", name: "b", path: "/tmp/b.csv" });
    await registerSessionSource(s, { sessionId: "ses_2", name: "c", path: "/tmp/c.csv" });

    const listed = await listSessionSources(s, "ses_1");
    expect(listed.map((x) => x.name)).toEqual(["b", "a"]);
    const other = await listSessionSources(s, "ses_2");
    expect(other.map((x) => x.name)).toEqual(["c"]);
    expect(await listSessionSources(s, "ses_none")).toEqual([]);
  });

  it("upserts on (session, name): re-registering replaces path/kind/row_count in place", async () => {
    const s = await store();
    await registerSessionSource(s, {
      sessionId: "ses_1",
      name: "loans",
      path: "/tmp/old.csv",
      rowCount: 10,
    });
    const updated = await registerSessionSource(s, {
      sessionId: "ses_1",
      name: "loans",
      path: "/tmp/new.csv",
      kind: "csv",
      rowCount: 20,
    });
    expect(updated.path).toBe("/tmp/new.csv");
    expect(updated.rowCount).toBe(20);
    // Still exactly one row for that (session, name).
    expect(await listSessionSources(s, "ses_1")).toHaveLength(1);
  });

  it("stores an injection-style name literally via a bound parameter", async () => {
    const s = await store();
    const evil = 'loans"; DROP TABLE platform.session_sources; --';
    await registerSessionSource(s, { sessionId: "ses_1", name: evil, path: "/tmp/x.csv" });
    const found = await getSessionSource(s, "ses_1", evil);
    expect(found?.name).toBe(evil);
    // The table still exists and holds the row (the payload was not executed).
    expect(await listSessionSources(s, "ses_1")).toHaveLength(1);
  });
});
