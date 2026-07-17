import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openStore, type WarehouseStore } from "../store/duckdb.js";
import { publishServing } from "../tools/serve.js";
import { SERVED_PAGE_DEFAULT_LIMIT, type ServedTable } from "../core/serving.js";
import { ServedExportMissingError, openServedCsv, readServedData } from "./reader.js";

/**
 * Integration tests for the serving read layer (T5.3 / PRD FR10) against real DuckDB and real
 * exports on disk. Each publishes through the real `publish_serving` tool and then reads the
 * result back, so the tests exercise the actual publish → serve seam rather than a hand-built
 * fixture. They assert the served values, the paging contract, that JSON-hostile warehouse types
 * survive the trip, and that data which was never published is never served.
 */
describe("served data reader", () => {
  const open: WarehouseStore[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(open.splice(0).map((s) => s.close()));
    await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function scaffold(): Promise<{ store: WarehouseStore; servingDir: string }> {
    const store = await openStore(":memory:");
    open.push(store);
    const dir = await mkdtemp(join(tmpdir(), "datastack-reader-"));
    tempDirs.push(dir);
    return { store, servingDir: join(dir, "serving") };
  }

  /** Publish `sql`'s table (shaped like the transform's per-branch report) and return the row. */
  async function publish(
    store: WarehouseStore,
    servingDir: string,
    sql: string,
    table = "branch_balance_totals",
  ): Promise<ServedTable> {
    await store.run(sql);
    return publishServing(store, { servingDir, projectId: "p1", runId: "r1", table });
  }

  const BRANCH_TOTALS = `CREATE OR REPLACE TABLE marts.branch_balance_totals AS
     SELECT * FROM (VALUES ('north', 1750.75), ('south', 0.0)) AS t(branch, total_balance)`;

  const page = { limit: SERVED_PAGE_DEFAULT_LIMIT, offset: 0 };

  it("serves a published table's columns, total row count and rows", async () => {
    const { store, servingDir } = await scaffold();
    const served = await publish(store, servingDir, BRANCH_TOTALS);

    const data = await readServedData(store, served, page);

    expect(data.name).toBe("branch_balance_totals");
    expect(data.schema).toBe("marts");
    expect(data.qualifiedTable).toBe("marts.branch_balance_totals");
    expect(data.endpoint).toBe("/api/serve/branch_balance_totals");
    expect(data.csvEndpoint).toBe("/api/serve/branch_balance_totals.csv");
    expect(data.columns).toEqual([
      { name: "branch", type: "VARCHAR" },
      { name: "total_balance", type: "DOUBLE" },
    ]);
    expect(data.rowCount).toBe(2);
    expect(data.limit).toBe(SERVED_PAGE_DEFAULT_LIMIT);
    expect(data.offset).toBe(0);
    // The transform's GROUP BY carries no ORDER BY, so row order is not a contract — assert the
    // exact rows without depending on which branch the engine grouped first.
    expect(data.rows).toHaveLength(2);
    expect(data.rows).toContainEqual({ branch: "north", total_balance: 1750.75 });
    expect(data.rows).toContainEqual({ branch: "south", total_balance: 0 });
  });

  it("serves the published snapshot, never un-published marts data", async () => {
    const { store, servingDir } = await scaffold();
    const served = await publish(store, servingDir, BRANCH_TOTALS);

    // A later run's transform replaces the marts table but its DQ fails, so publish never runs.
    // The endpoint must keep serving what was actually published and approved (FR7/FR8).
    await store.run(
      `CREATE OR REPLACE TABLE marts.branch_balance_totals AS
         SELECT * FROM (VALUES ('leaked', -999.0)) AS t(branch, total_balance)`,
    );

    const data = await readServedData(store, served, page);

    expect(data.rowCount).toBe(2);
    expect(data.rows).toContainEqual({ branch: "north", total_balance: 1750.75 });
    expect(data.rows.map((r) => r.branch)).not.toContain("leaked");
  });

  it("pages through the rows while reporting the total", async () => {
    const { store, servingDir } = await scaffold();
    const served = await publish(
      store,
      servingDir,
      `CREATE OR REPLACE TABLE marts.branch_balance_totals AS
         SELECT i AS branch_id, i * 1.5 AS total_balance FROM range(1, 6) AS t(i)`,
    );

    const first = await readServedData(store, served, { limit: 2, offset: 0 });
    const second = await readServedData(store, served, { limit: 2, offset: 2 });
    const last = await readServedData(store, served, { limit: 2, offset: 4 });
    const beyond = await readServedData(store, served, { limit: 2, offset: 99 });

    // rowCount is the total available, independent of the page actually returned.
    for (const p of [first, second, last, beyond]) expect(p.rowCount).toBe(5);
    expect(first.rows).toHaveLength(2);
    expect(second.rows).toHaveLength(2);
    expect(last.rows).toHaveLength(1);
    expect(beyond.rows).toEqual([]);
    expect(first.limit).toBe(2);
    expect(second.offset).toBe(2);

    // A file has a fixed row order, so the pages tile the table exactly: no gaps, no repeats.
    const paged = [...first.rows, ...second.rows, ...last.rows];
    expect(paged).toEqual((await readServedData(store, served, { limit: 5, offset: 0 })).rows);
    expect(new Set(paged.map((r) => r.branch_id)).size).toBe(5);
  });

  it("coerces warehouse types JSON cannot carry, keeping the response serializable", async () => {
    const { store, servingDir } = await scaffold();
    const served = await publish(
      store,
      servingDir,
      `CREATE OR REPLACE TABLE marts.typed AS SELECT
         42::BIGINT          AS count_col,
         1750.75::DOUBLE     AS amount_col,
         DATE '2026-07-17'   AS date_col,
         TIMESTAMP '2026-07-17 10:30:00' AS ts_col,
         true                AS flag_col,
         NULL::VARCHAR       AS missing_col`,
      "typed",
    );

    const data = await readServedData(store, served, page);

    // DuckDB hands these back as bigint / DuckDBDateValue / DuckDBTimestampValue objects; the
    // response must carry plain JSON values with the same meaning.
    expect(data.rows).toEqual([
      {
        count_col: 42,
        amount_col: 1750.75,
        date_col: "2026-07-17",
        ts_col: "2026-07-17 10:30:00",
        flag_col: true,
        missing_col: null,
      },
    ]);
    // The point of the coercion: an un-coerced bigint makes this throw.
    expect(() => JSON.stringify(data)).not.toThrow();
    expect(JSON.parse(JSON.stringify(data)).rows).toEqual(data.rows);
  });

  it("serves an empty published table as its columns with no rows", async () => {
    const { store, servingDir } = await scaffold();
    const served = await publish(
      store,
      servingDir,
      `CREATE OR REPLACE TABLE marts.branch_balance_totals (branch VARCHAR, total_balance DOUBLE)`,
    );

    const data = await readServedData(store, served, page);

    expect(data.rowCount).toBe(0);
    expect(data.rows).toEqual([]);
    expect(data.columns.map((c) => c.name)).toEqual(["branch", "total_balance"]);
  });

  it("streams the published CSV byte-for-byte with its size", async () => {
    const { store, servingDir } = await scaffold();
    const served = await publish(store, servingDir, BRANCH_TOTALS);

    const { stream, size } = await openServedCsv(served);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const streamed = Buffer.concat(chunks);

    const onDisk = await readFile(served.csvPath);
    expect(streamed.equals(onDisk)).toBe(true);
    expect(size).toBe(onDisk.byteLength);
    // The download is a real CSV: a header line plus one line per served row.
    expect(streamed.toString("utf8").split("\n").filter(Boolean)).toHaveLength(3);
    expect(streamed.toString("utf8").split("\n")[0]).toBe("branch,total_balance");
  });

  it("reports a registered name whose export was deleted, rather than failing obscurely", async () => {
    const { store, servingDir } = await scaffold();
    const served = await publish(store, servingDir, BRANCH_TOTALS);
    await rm(served.csvPath);

    await expect(readServedData(store, served, page)).rejects.toThrow(ServedExportMissingError);
    await expect(openServedCsv(served)).rejects.toThrow(ServedExportMissingError);
    await expect(readServedData(store, served, page)).rejects.toThrow(served.csvPath);
  });
});
