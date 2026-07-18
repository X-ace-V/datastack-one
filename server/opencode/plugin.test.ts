import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PluginInput } from "@opencode-ai/plugin";
import type { ToolContext, ToolDefinition } from "@opencode-ai/plugin/tool";
import { DatastackToolsPlugin } from "../tools/plugin.js";
import { ASK_TOOLS } from "./config.js";
import { buildServer } from "../app.js";
import { openStore, type WarehouseStore } from "../store/duckdb.js";
import { registerSessionSource } from "../store/session-sources.js";
import { createToolApprovalGate, type ToolApprovalGate } from "./tool-approvals.js";
import type { ApprovalAction, ApprovalRequest } from "../core/approvals.js";
import type { NormalizedEvent } from "../core/events.js";

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

  const TOOL_NAMES = [
    "list_sources",
    "profile_source",
    "run_query",
    "land_parquet",
    "load_warehouse",
    "run_transform",
    "publish_serving",
  ] as const;

  type Tools = Record<(typeof TOOL_NAMES)[number], ToolDefinition>;

  /** The plugin ignores its input; a minimal cast is enough to instantiate it. */
  async function instantiate(): Promise<Tools> {
    const hooks = await DatastackToolsPlugin({} as unknown as PluginInput);
    const registered = (hooks.tool ?? {}) as Record<string, ToolDefinition | undefined>;
    const tools = {} as Tools;
    for (const name of TOOL_NAMES) {
      const def = registered[name];
      if (!def) throw new Error(`plugin did not register the expected tool "${name}"`);
      tools[name] = def;
    }
    return tools;
  }

  /** The exact set of tool names the plugin registers, sorted — for the drift assertion. */
  async function registeredToolNames(): Promise<string[]> {
    const hooks = await DatastackToolsPlugin({} as unknown as PluginInput);
    return Object.keys(hooks.tool ?? {}).sort();
  }

  /** A fake ToolContext carrying just the session id the tools read. */
  function ctx(sessionID: string): ToolContext {
    return { sessionID } as unknown as ToolContext;
  }

  /** Whether `<schema>.<table>` currently exists in the store (a write's observable side effect). */
  async function tableExists(
    store: WarehouseStore,
    schema: string,
    table: string,
  ): Promise<boolean> {
    const rows = await store.all(
      "SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2",
      [schema, table],
    );
    return rows.length > 0;
  }

  /**
   * A backend wired with the real write-tool approval gate (V4.1). The gate auto-answers each
   * pending approval with `answer` — modelling the human — so a write tool's blocking route
   * resolves. `onPending` (optional) runs at approval time BEFORE the reply, so a test can assert
   * the write has not happened yet (the "did NOT run before approval" invariant). Every emitted
   * SSE event is captured for assertions.
   */
  async function backend(): Promise<{
    store: WarehouseStore;
    landingDir: string;
    servingDir: string;
    gate: ToolApprovalGate;
    emitted: NormalizedEvent[];
    setAnswer: (
      answer: ApprovalAction,
      onPending?: (req: ApprovalRequest) => void | Promise<void>,
    ) => void;
    close: () => Promise<void>;
  }> {
    const store = await openStore(":memory:");
    open.push(store);
    const emitted: NormalizedEvent[] = [];
    let answer: ApprovalAction = "approve";
    let onPending: ((req: ApprovalRequest) => void | Promise<void>) | undefined;
    let gate: ToolApprovalGate;
    gate = createToolApprovalGate((event) => {
      emitted.push(event);
      if (event.kind === "approval") {
        const req = event;
        // Defer past request()'s return, then answer as the human would.
        queueMicrotask(async () => {
          if (onPending) await onPending(req);
          gate.reply(req.requestID, answer);
        });
      }
    });
    const landingDir = await mkdtemp(join(tmpdir(), "plugin-land-"));
    const servingDir = await mkdtemp(join(tmpdir(), "plugin-serve-"));
    tmpDirs.push(landingDir, servingDir);
    const app = buildServer({ store, landingDir, servingDir, toolApprovals: gate });
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    process.env.DATASTACK_INTERNAL_URL = address;
    return {
      store,
      landingDir,
      servingDir,
      gate,
      emitted,
      setAnswer: (a, op) => {
        answer = a;
        onPending = op;
      },
      close: () => app.close(),
    };
  }

  it("registers the read tools and the four write tools with descriptions and args", async () => {
    expect(await registeredToolNames()).toEqual([
      "land_parquet",
      "list_sources",
      "load_warehouse",
      "profile_source",
      "publish_serving",
      "run_query",
      "run_transform",
    ]);
    const tools = await instantiate();
    expect(tools.list_sources.description).toMatch(/list the data sources/i);
    expect(tools.profile_source.description).toMatch(/profile/i);
    expect(tools.run_query.description).toMatch(/read-only sql select/i);
    // profile_source takes a `source` name; list_sources takes no args; run_query takes `sql`.
    expect(Object.keys(tools.profile_source.args)).toEqual(["source"]);
    expect(Object.keys(tools.list_sources.args)).toEqual([]);
    expect(Object.keys(tools.run_query.args)).toEqual(["sql"]);
    // The four write tools carry their approval-gated args.
    expect(Object.keys(tools.land_parquet.args).sort()).toEqual(["ingestionDate", "source"]);
    expect(Object.keys(tools.load_warehouse.args).sort()).toEqual(["dataset", "schema", "table"]);
    expect(Object.keys(tools.run_transform.args).sort()).toEqual(["sql", "targetTable"]);
    expect(Object.keys(tools.publish_serving.args).sort()).toEqual(["name", "table"]);
  });

  it("registers a gated tool for exactly each ASK_TOOL, each describing its approval", async () => {
    const tools = await instantiate();
    // Every approval-gated tool name in the single source of truth is a registered tool whose
    // description tells the model it pauses for approval — guards against gate drift.
    for (const name of ASK_TOOLS) {
      expect(tools[name], `ASK_TOOL "${name}" is not registered`).toBeDefined();
      expect(tools[name].description, `${name} must describe its approval pause`).toMatch(
        /approval/i,
      );
    }
    // The read tools are NOT gated, so they must not claim to pause.
    for (const name of ["list_sources", "profile_source", "run_query"] as const) {
      expect((ASK_TOOLS as readonly string[]).includes(name)).toBe(false);
    }
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

  // FR8/FR10: the write tools must pause for an inline approval and only write once allowed.
  // These drive the real loopback + real DuckDB + the real backend approval gate (auto-answering
  // as the human would), the exact path the agent triggers minus the model.

  it("gates the whole build chain and only writes AFTER each approval (FR8/FR10)", async () => {
    const { store, landingDir, emitted, setAnswer, close } = await backend();
    try {
      const path = await csvFile("loans.csv", LOANS_CSV);
      await registerSessionSource(store, { sessionId: "ses_w", name: "loans", path });
      const tools = await instantiate();
      setAnswer("approve");

      // land_parquet — approved; the landed dataset comes back (never an on-disk path, FR5b).
      const landRes = await tools.land_parquet.execute({ source: "loans" }, ctx("ses_w"));
      const land = landRes as unknown as { metadata: { land: { dataset: string; rowCount: number } } };
      expect(land.metadata.land.rowCount).toBe(4);
      expect(JSON.stringify(landRes)).not.toContain(landingDir);
      const dataset = land.metadata.land.dataset;

      // load_warehouse — the approval fires while raw.source still does NOT exist, proving the
      // write is strictly after approval; the table exists only once the tool returns.
      setAnswer("approve", async () => {
        expect(await tableExists(store, "raw", "source")).toBe(false);
      });
      const loadRes = await tools.load_warehouse.execute({ dataset }, ctx("ses_w"));
      const load = loadRes as unknown as { metadata: { load: { qualifiedTable: string; rowCount: number } } };
      expect(load.metadata.load.qualifiedTable).toBe("raw.source");
      expect(load.metadata.load.rowCount).toBe(4);
      expect(await tableExists(store, "raw", "source")).toBe(true);

      // run_transform — same ordering proof against the marts output it creates.
      const sql =
        "CREATE OR REPLACE TABLE marts.branch_totals AS " +
        "SELECT branch, count(*)::BIGINT AS n FROM raw.source GROUP BY branch";
      setAnswer("approve", async () => {
        expect(await tableExists(store, "marts", "branch_totals")).toBe(false);
      });
      const txRes = await tools.run_transform.execute(
        { sql, targetTable: "branch_totals" },
        ctx("ses_w"),
      );
      const tx = txRes as unknown as { metadata: { transform: { qualifiedTable: string; rowCount: number } } };
      expect(tx.metadata.transform.qualifiedTable).toBe("marts.branch_totals");
      expect(tx.metadata.transform.rowCount).toBe(3);
      expect(await tableExists(store, "marts", "branch_totals")).toBe(true);

      // publish_serving — approved; registers a served endpoint over the marts table.
      setAnswer("approve");
      const pubRes = await tools.publish_serving.execute({ table: "branch_totals" }, ctx("ses_w"));
      const pub = pubRes as unknown as { metadata: { publish: { name: string; endpoint: string } } };
      expect(pub.metadata.publish.name).toBe("branch_totals");
      expect(pub.metadata.publish.endpoint).toContain("branch_totals");

      // Every write surfaced an inline approval (SSE) and its resolution, in order, each naming
      // its own gated tool — the exact FR10 pill sequence.
      const approvals = emitted.filter((e) => e.kind === "approval");
      expect(approvals.map((a) => (a as { type: string }).type)).toEqual([
        "land_parquet",
        "load_warehouse",
        "run_transform",
        "publish_serving",
      ]);
      expect(emitted.filter((e) => e.kind === "approval_resolved")).toHaveLength(4);
      // The transform's approval carried the EXACT SQL a human reviews (FR10).
      const txApproval = approvals.find((a) => (a as { type: string }).type === "run_transform") as
        | { metadata: { sql?: string } }
        | undefined;
      expect(txApproval?.metadata.sql).toBe(sql);
    } finally {
      await close();
    }
  });

  it("denies a write: nothing runs when the approval is rejected", async () => {
    const { store, emitted, setAnswer, close } = await backend();
    try {
      const path = await csvFile("loans.csv", LOANS_CSV);
      await registerSessionSource(store, { sessionId: "ses_d", name: "loans", path });
      const tools = await instantiate();
      setAnswer("reject");

      const results = [
        await tools.land_parquet.execute({ source: "loans" }, ctx("ses_d")),
        await tools.load_warehouse.execute({ dataset: "loans" }, ctx("ses_d")),
        await tools.run_transform.execute(
          { sql: "CREATE OR REPLACE TABLE marts.x AS SELECT 1 AS a", targetTable: "x" },
          ctx("ses_d"),
        ),
        await tools.publish_serving.execute({ table: "x" }, ctx("ses_d")),
      ];

      // Each tool surfaced an approval, was rejected, and returned a "denied, nothing written".
      expect(emitted.filter((e) => e.kind === "approval")).toHaveLength(4);
      for (const r of results) {
        expect(typeof r).toBe("string");
        expect(r as string).toMatch(/was not run: the approval was denied/);
      }
      // No write reached the store: raw.source was never loaded and marts.x was never created —
      // proving the tool did NOT run before approval.
      expect(await tableExists(store, "raw", "source")).toBe(false);
      expect(await tableExists(store, "marts", "x")).toBe(false);
    } finally {
      await close();
    }
  });
});
