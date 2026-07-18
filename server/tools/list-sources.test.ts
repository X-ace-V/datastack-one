import { afterEach, describe, expect, it } from "vitest";
import { openStore, type WarehouseStore } from "../store/duckdb.js";
import { registerSessionSource } from "../store/session-sources.js";
import { listSourcesForSession } from "./list-sources.js";

/**
 * Unit tests for the `list_sources` tool (V3.1, FR4/FR5b). The assertion that matters: the tool
 * returns model-safe views — name/kind/rowCount only — and never the on-disk `path`.
 */
describe("list_sources tool", () => {
  const open: WarehouseStore[] = [];

  afterEach(async () => {
    await Promise.all(open.splice(0).map((s) => s.close()));
  });

  async function store(): Promise<WarehouseStore> {
    const s = await openStore(":memory:");
    open.push(s);
    return s;
  }

  it("returns an empty list for a session with no sources", async () => {
    const s = await store();
    expect(await listSourcesForSession(s, "ses_1")).toEqual([]);
  });

  it("returns the session's sources as model-safe views without paths", async () => {
    const s = await store();
    await registerSessionSource(s, {
      sessionId: "ses_1",
      name: "loans",
      path: "/tmp/secret/loans.csv",
      rowCount: 24,
    });
    const listed = await listSourcesForSession(s, "ses_1");
    expect(listed).toEqual([{ name: "loans", kind: "csv", rowCount: 24 }]);
    expect(JSON.stringify(listed)).not.toContain("secret");
  });
});
