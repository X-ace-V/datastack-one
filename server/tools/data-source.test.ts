import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openStore, type WarehouseStore } from "../store/duckdb.js";
import { dataSourceRelation, loadDataRowCount } from "./data-source.js";

describe("data source relations", () => {
  const stores: WarehouseStore[] = [];
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(stores.splice(0).map((store) => store.close()));
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("builds the correct DuckDB reader for every queryable file kind", () => {
    expect(dataSourceRelation("csv", "?")).toBe("read_csv_auto(?)");
    expect(dataSourceRelation("tsv", "?")).toBe("read_csv_auto(?, delim='\\t')");
    expect(dataSourceRelation("json", "?")).toBe("read_json_auto(?)");
    expect(dataSourceRelation("jsonl", "?")).toBe("read_json_auto(?)");
    expect(dataSourceRelation("parquet", "?")).toBe("read_parquet(?)");
    expect(() => dataSourceRelation("sql", "?")).toThrow(/not queryable/i);
  });

  it("fully scans CSV, TSV, and JSON uploads and reports their row counts", async () => {
    const store = await openStore(":memory:");
    stores.push(store);
    const dir = await mkdtemp(join(tmpdir(), "data-source-"));
    dirs.push(dir);
    const csv = join(dir, "rows.csv");
    const tsv = join(dir, "rows.tsv");
    const json = join(dir, "rows.json");
    await writeFile(csv, "id\n1\n2\n");
    await writeFile(tsv, "id\tname\n1\ta\n2\tb\n3\tc\n");
    await writeFile(json, '[{"id":1},{"id":2}]');

    await expect(loadDataRowCount(store, csv, "csv")).resolves.toBe(2);
    await expect(loadDataRowCount(store, tsv, "tsv")).resolves.toBe(3);
    await expect(loadDataRowCount(store, json, "json")).resolves.toBe(2);
  });
});
