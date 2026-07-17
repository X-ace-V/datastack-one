import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openStore, type WarehouseStore } from "../store/duckdb.js";
import { getServedTable } from "../store/serving.js";
import { planPublishServing, publishServing } from "./serve.js";

/**
 * Integration tests for the `publish_serving` tool (T5.2 / PRD FR10) against real DuckDB and a
 * real serving dir on disk. They assert the desired result rather than "it ran": the CSV export
 * exists with a header and every row of the marts table, the registry resolves the served name
 * back to that table with the right row count and endpoints, re-publishing replaces the row
 * (one endpoint, one table), a crafted name cannot escape the serving dir, and a publish of a
 * table the transform never created fails instead of serving an empty endpoint.
 */
describe("publish_serving tool", () => {
  const open: WarehouseStore[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(open.splice(0).map((s) => s.close()));
    await Promise.all(
      tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
    );
  });

  /** A store holding a marts table shaped like the transform stage's per-branch report. */
  async function scaffold(): Promise<{ store: WarehouseStore; servingDir: string }> {
    const store = await openStore(":memory:");
    open.push(store);
    const dir = await mkdtemp(join(tmpdir(), "datastack-serve-"));
    tempDirs.push(dir);
    await store.run(
      `CREATE OR REPLACE TABLE marts.branch_balance_totals AS
         SELECT * FROM (VALUES ('north', 1750.75), ('south', 0.0)) AS t(branch, total_balance)`,
    );
    return { store, servingDir: join(dir, "serving") };
  }

  it("exports the marts table to CSV and registers it as the served table", async () => {
    const { store, servingDir } = await scaffold();

    const served = await publishServing(store, {
      servingDir,
      projectId: "p1",
      runId: "r1",
      table: "branch_balance_totals",
    });

    // The registered row describes exactly what was published.
    expect(served).toEqual({
      name: "branch_balance_totals",
      projectId: "p1",
      runId: "r1",
      schema: "marts",
      table: "branch_balance_totals",
      qualifiedTable: "marts.branch_balance_totals",
      format: "csv",
      rowCount: 2,
      csvPath: join(servingDir, "p1", "branch_balance_totals.csv"),
      endpoint: "/api/serve/branch_balance_totals",
      csvEndpoint: "/api/serve/branch_balance_totals.csv",
      publishedAt: expect.any(String),
    });

    // The CSV on disk carries a header plus every row — the FR10 "downloadable" artifact.
    // (The fixture's VALUES literals are DECIMAL, so DuckDB writes `0` as `0.00`.)
    const csv = await readFile(served.csvPath, "utf8");
    expect(csv).toBe("branch,total_balance\nnorth,1750.75\nsouth,0.00\n");

    // The registry resolves the served name back to the table (what T5.3's route will do).
    const found = await getServedTable(store, "branch_balance_totals");
    expect(found).toEqual(served);
  });

  it("re-publishing a name replaces its registration rather than adding a second claim", async () => {
    const { store, servingDir } = await scaffold();
    const first = await publishServing(store, {
      servingDir,
      projectId: "p1",
      runId: "r1",
      table: "branch_balance_totals",
    });
    expect(first.rowCount).toBe(2);

    // A later run's transform narrows the report to one branch, then republishes the same name.
    await store.run(
      `CREATE OR REPLACE TABLE marts.branch_balance_totals AS
         SELECT * FROM (VALUES ('north', 1750.75)) AS t(branch, total_balance)`,
    );
    const second = await publishServing(store, {
      servingDir,
      projectId: "p1",
      runId: "r2",
      table: "branch_balance_totals",
    });

    // One row per served name — the endpoint now resolves to the newest publish, not both.
    const rows = await store.all(
      `SELECT count(*)::BIGINT AS n FROM platform.served_tables WHERE name = 'branch_balance_totals'`,
    );
    expect(Number(rows[0]?.n)).toBe(1);
    expect(second.rowCount).toBe(1);
    expect(second.runId).toBe("r2");
    expect((await getServedTable(store, "branch_balance_totals"))?.rowCount).toBe(1);

    // The export was rewritten too, so the download matches the re-served data.
    expect(await readFile(second.csvPath, "utf8")).toBe("branch,total_balance\nnorth,1750.75\n");
  });

  it("serves an explicit name, and confines a traversing name to the serving dir", async () => {
    const { store, servingDir } = await scaffold();

    const served = await publishServing(store, {
      servingDir,
      projectId: "p1",
      table: "branch_balance_totals",
      name: "../../../etc/daily.report",
    });

    // The name is sanitized for both the URL and the file path: no traversal, no dot.
    expect(served.name).toBe("daily_report");
    expect(served.endpoint).toBe("/api/serve/daily_report");
    expect(served.csvPath).toBe(join(servingDir, "p1", "daily_report.csv"));
    expect(await getServedTable(store, "daily_report")).not.toBeNull();
    expect(await readFile(served.csvPath, "utf8")).toContain("north,1750.75");
  });

  it("publishes an empty marts table as a header-only CSV rather than failing", async () => {
    const { store, servingDir } = await scaffold();
    await store.run(
      `CREATE OR REPLACE TABLE marts.empty_report AS
         SELECT * FROM (VALUES ('north', 1.0)) AS t(branch, total_balance) WHERE false`,
    );

    const served = await publishServing(store, {
      servingDir,
      projectId: "p1",
      table: "empty_report",
    });

    expect(served.rowCount).toBe(0);
    expect(await readFile(served.csvPath, "utf8")).toBe("branch,total_balance\n");
  });

  it("fails when the marts table does not exist, rather than serving an empty endpoint", async () => {
    const { store, servingDir } = await scaffold();

    await expect(
      publishServing(store, { servingDir, projectId: "p1", table: "never_created" }),
    ).rejects.toThrow();

    // Nothing was registered, so no endpoint promises data that isn't there.
    expect(await getServedTable(store, "never_created")).toBeNull();
  });

  it("plans the exact SQL it later executes, so the approval gate shows what runs", async () => {
    const { store, servingDir } = await scaffold();
    const plan = planPublishServing({
      servingDir,
      projectId: "p1",
      table: "branch_balance_totals",
    });

    expect(plan.sql).toBe(
      `COPY (SELECT * FROM "marts"."branch_balance_totals") ` +
        `TO '${join(servingDir, "p1", "branch_balance_totals.csv")}' (FORMAT CSV, HEADER)`,
    );

    // Running the planned SQL is what the tool does: same destination, same data.
    const served = await publishServing(store, {
      servingDir,
      projectId: "p1",
      table: "branch_balance_totals",
    });
    expect(served.csvPath).toBe(plan.csvPath);
    expect(served.endpoint).toBe(plan.endpoint);
  });
});
