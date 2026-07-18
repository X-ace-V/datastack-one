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

  it("includes attached Postgres tables by their qualified name (V5.3)", async () => {
    const s = await store();
    // An attach_source (V5.2) registers each attached table as a `postgres` session source under
    // its qualified `<alias>.<schema>.<table>` name — the identifier run_query resolves. list_sources
    // must surface it alongside CSV sources so the agent can address the PG tables by name (FR5b).
    await registerSessionSource(s, {
      sessionId: "ses_1",
      name: "loans_csv",
      path: "/tmp/loans.csv",
    });
    await registerSessionSource(s, {
      sessionId: "ses_1",
      name: "neon.public.borrowers",
      kind: "postgres",
      path: "neon.public.borrowers",
    });

    const listed = await listSourcesForSession(s, "ses_1");
    const pg = listed.find((src) => src.name === "neon.public.borrowers");
    expect(pg).toEqual({ name: "neon.public.borrowers", kind: "postgres", rowCount: null });
    // The qualified name is not a path, but the model-safe view still carries no `path` field at all.
    expect(pg && "path" in pg).toBe(false);
  });
});
