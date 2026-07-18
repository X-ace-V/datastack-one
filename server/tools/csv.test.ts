import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openStore, type WarehouseStore } from "../store/duckdb.js";
import { loadCsvRowCount } from "./csv.js";

/**
 * Integration tests for {@link loadCsvRowCount} (V3.2, FR4) against a real in-memory DuckDB and
 * real CSV files on disk. They assert the desired value — the exact data-row count DuckDB reads
 * (header excluded), including the header-only zero-row case — and that an unreadable path throws
 * so the upload route can turn that into a 422 rather than a 500.
 */
describe("loadCsvRowCount", () => {
  const open: WarehouseStore[] = [];
  const tmpDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(open.splice(0).map((s) => s.close()));
    await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function store(): Promise<WarehouseStore> {
    const s = await openStore(":memory:");
    open.push(s);
    return s;
  }

  async function csvFile(name: string, contents: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "load-csv-"));
    tmpDirs.push(dir);
    const path = join(dir, name);
    await writeFile(path, contents);
    return path;
  }

  it("returns the exact number of data rows DuckDB reads", async () => {
    const s = await store();
    const path = await csvFile(
      "loans.csv",
      "loan_id,branch,balance\n1,north,1000.50\n2,south,\n3,north,750.25\n",
    );
    expect(await loadCsvRowCount(s, path)).toBe(3);
  });

  it("counts a header-only CSV as zero rows (still loadable)", async () => {
    const s = await store();
    const path = await csvFile("empty.csv", "loan_id,branch\n");
    expect(await loadCsvRowCount(s, path)).toBe(0);
  });

  it("throws when DuckDB cannot read the file, so the caller can 422", async () => {
    const s = await store();
    const missing = join(tmpdir(), "datastack-definitely-absent-xyz.csv");
    await expect(loadCsvRowCount(s, missing)).rejects.toThrow();
  });
});
