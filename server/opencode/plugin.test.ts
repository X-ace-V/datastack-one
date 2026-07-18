import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PluginInput } from "@opencode-ai/plugin";
import type { ToolContext, ToolDefinition } from "@opencode-ai/plugin/tool";
import { DatastackToolsPlugin } from "../tools/plugin.js";
import { buildServer } from "../app.js";
import { openStore, type WarehouseStore } from "../store/duckdb.js";
import { registerSessionSource } from "../store/session-sources.js";

/**
 * Tests for the agent-tools plugin (V3.1, FR4/FR6). This is the seam that lets the agent call
 * `list_sources`/`profile_source`: the plugin runs in OpenCode's runtime and reaches this
 * backend over loopback. We do NOT boot the `opencode` binary here (that's the live DoD #6
 * smoke) — instead we prove the plugin's own contract deterministically:
 *
 *  1. the plugin registers `list_sources` + `profile_source` with descriptions and args, and
 *  2. their `execute()` drives the REAL loopback route against a REAL backend (over a socket),
 *     returning the model-safe result — the exact path the agent triggers, minus the model.
 */
describe("data-tools plugin", () => {
  const open: WarehouseStore[] = [];
  const tmpDirs: string[] = [];
  const prevInternalUrl = process.env.DATASTACK_INTERNAL_URL;

  afterEach(async () => {
    await Promise.all(open.splice(0).map((s) => s.close()));
    await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
    if (prevInternalUrl === undefined) delete process.env.DATASTACK_INTERNAL_URL;
    else process.env.DATASTACK_INTERNAL_URL = prevInternalUrl;
  });

  const LOANS_CSV =
    "loan_id,customer_id,branch,balance,opened_at\n" +
    "1,100,north,1000.50,2024-01-01\n" +
    "2,101,south,,2024-01-02\n" +
    "3,100,north,750.25,2024-02-15\n" +
    "4,102,west,500.00,2024-03-10\n";

  async function csvFile(name: string, contents: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "plugin-test-"));
    tmpDirs.push(dir);
    const path = join(dir, name);
    await writeFile(path, contents);
    return path;
  }

  /** The plugin ignores its input; a minimal cast is enough to instantiate it. */
  async function instantiate(): Promise<{
    tools: Record<string, ToolDefinition>;
    list_sources: ToolDefinition;
    profile_source: ToolDefinition;
    run_query: ToolDefinition;
  }> {
    const hooks = await DatastackToolsPlugin({} as unknown as PluginInput);
    const tools = (hooks.tool ?? {}) as Record<string, ToolDefinition>;
    const list_sources = tools.list_sources;
    const profile_source = tools.profile_source;
    const run_query = tools.run_query;
    if (!list_sources || !profile_source || !run_query) {
      throw new Error("plugin did not register the expected tools");
    }
    return { tools, list_sources, profile_source, run_query };
  }

  /** A fake ToolContext carrying just the session id the tools read. */
  function ctx(sessionID: string): ToolContext {
    return { sessionID } as unknown as ToolContext;
  }

  /** Boot a real backend over a socket, point the plugin's loopback at it, seed sources. */
  async function backend(): Promise<{ store: WarehouseStore; close: () => Promise<void> }> {
    const store = await openStore(":memory:");
    open.push(store);
    const app = buildServer({ store });
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    process.env.DATASTACK_INTERNAL_URL = address;
    return { store, close: () => app.close() };
  }

  it("registers list_sources, profile_source and run_query with descriptions and args", async () => {
    const { tools, list_sources, profile_source, run_query } = await instantiate();
    expect(Object.keys(tools).sort()).toEqual(["list_sources", "profile_source", "run_query"]);
    expect(list_sources.description).toMatch(/list the data sources/i);
    expect(profile_source.description).toMatch(/profile/i);
    expect(run_query.description).toMatch(/read-only sql select/i);
    // profile_source takes a `source` name; list_sources takes no args; run_query takes `sql`.
    expect(Object.keys(profile_source.args)).toEqual(["source"]);
    expect(Object.keys(list_sources.args)).toEqual([]);
    expect(Object.keys(run_query.args)).toEqual(["sql"]);
  });

  it("list_sources returns a formatted list via the real loopback", async () => {
    const { store, close } = await backend();
    try {
      await registerSessionSource(store, {
        sessionId: "ses_1",
        name: "loans",
        path: "/tmp/secret/loans.csv",
        rowCount: 24,
      });
      const { list_sources } = await instantiate();
      const result = await list_sources.execute({}, ctx("ses_1"));
      // A populated list comes back as a structured ToolResult.
      expect(typeof result).not.toBe("string");
      const structured = result as { output: string; metadata: { sources: unknown[] } };
      expect(structured.output).toContain("loans");
      expect(structured.output).toContain("24 rows");
      expect(structured.metadata.sources).toHaveLength(1);
      // The internal path is never surfaced to the model.
      expect(JSON.stringify(result)).not.toContain("secret");
    } finally {
      await close();
    }
  });

  it("list_sources reports an empty session in plain words", async () => {
    const { close } = await backend();
    try {
      const { list_sources } = await instantiate();
      const result = await list_sources.execute({}, ctx("ses_empty"));
      expect(result).toBe(
        "No data sources are connected to this session yet. Upload a CSV to add one.",
      );
    } finally {
      await close();
    }
  });

  it("profile_source returns the profile via the real loopback", async () => {
    const { store, close } = await backend();
    try {
      const path = await csvFile("loans.csv", LOANS_CSV);
      await registerSessionSource(store, { sessionId: "ses_1", name: "loans", path });
      const { profile_source } = await instantiate();
      const result = await profile_source.execute({ source: "loans" }, ctx("ses_1"));
      const structured = result as { output: string; metadata: { profile: { rowCount: number } } };
      expect(structured.metadata.profile.rowCount).toBe(4);
      expect(structured.output).toContain("loan_id");
      expect(structured.output).toContain("Candidate keys: loan_id");
    } finally {
      await close();
    }
  });

  it("profile_source explains a name that is not connected to the session", async () => {
    const { close } = await backend();
    try {
      const { profile_source } = await instantiate();
      const result = await profile_source.execute({ source: "ghost" }, ctx("ses_1"));
      expect(result).toContain('No source named "ghost"');
      expect(result).toContain("list_sources");
    } finally {
      await close();
    }
  });

  it("run_query returns the structured result + a readable table via the real loopback", async () => {
    const { store, close } = await backend();
    try {
      const path = await csvFile("loans.csv", LOANS_CSV);
      await registerSessionSource(store, { sessionId: "ses_1", name: "loans", path });
      const { run_query } = await instantiate();
      const result = await run_query.execute(
        { sql: "SELECT branch, SUM(COALESCE(balance,0)) AS total FROM loans GROUP BY branch" },
        ctx("ses_1"),
      );
      expect(typeof result).not.toBe("string");
      const structured = result as {
        output: string;
        metadata: { result: { columns: { name: string }[]; rows: unknown[] } };
      };
      // The panel payload carries the real columns/rows; the model-facing output is a readable table.
      expect(structured.metadata.result.columns.map((c) => c.name)).toEqual(["branch", "total"]);
      expect(structured.metadata.result.rows).toHaveLength(3);
      expect(structured.output).toContain("branch | total");
      expect(structured.output).toContain("north");
    } finally {
      await close();
    }
  });

  it("run_query reports a rejected non-read-only query in words the agent can act on", async () => {
    const { store, close } = await backend();
    try {
      const path = await csvFile("loans.csv", LOANS_CSV);
      await registerSessionSource(store, { sessionId: "ses_1", name: "loans", path });
      const { run_query } = await instantiate();
      const result = await run_query.execute({ sql: "DROP TABLE loans" }, ctx("ses_1"));
      expect(typeof result).toBe("string");
      expect(result as string).toContain("Query failed");
    } finally {
      await close();
    }
  });
});
