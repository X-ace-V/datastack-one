import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  openStore,
  migrate,
  PLATFORM_TABLES,
  WAREHOUSE_SCHEMAS,
  type WarehouseStore,
} from "./duckdb.js";

/**
 * Migration test for the DuckDB metadata store (T0.4). Asserts the desired
 * result — that opening a fresh store leaves every schema and every `platform`
 * table in place, that the DDL is genuinely idempotent, and that the tables
 * behave (defaults apply, rows round-trip).
 */
describe("DuckDB warehouse store", () => {
  const open: WarehouseStore[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(open.splice(0).map((s) => s.close()));
    await Promise.all(
      tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
    );
  });

  async function freshStore(path = ":memory:"): Promise<WarehouseStore> {
    const store = await openStore(path);
    open.push(store);
    return store;
  }

  async function schemaNames(store: WarehouseStore): Promise<Set<string>> {
    const rows = await store.all(
      "SELECT schema_name FROM information_schema.schemata",
    );
    return new Set(rows.map((r) => String(r.schema_name)));
  }

  async function platformTableNames(store: WarehouseStore): Promise<Set<string>> {
    const rows = await store.all(
      "SELECT table_name FROM information_schema.tables " +
        "WHERE table_schema = 'platform' AND table_type = 'BASE TABLE'",
    );
    return new Set(rows.map((r) => String(r.table_name)));
  }

  it("creates all four warehouse schemas", async () => {
    const store = await freshStore();
    const schemas = await schemaNames(store);
    for (const schema of WAREHOUSE_SCHEMAS) {
      expect(schemas.has(schema)).toBe(true);
    }
  });

  it("creates exactly the declared platform metadata tables", async () => {
    const store = await freshStore();
    const tables = await platformTableNames(store);
    expect(tables).toEqual(new Set(PLATFORM_TABLES));
  });

  it("is idempotent: re-migrating an open store is a no-op, not an error", async () => {
    const store = await freshStore();
    await expect(migrate(store)).resolves.toBeUndefined();
    // Everything still present, nothing duplicated or dropped.
    expect(await platformTableNames(store)).toEqual(new Set(PLATFORM_TABLES));
    const schemas = await schemaNames(store);
    for (const schema of WAREHOUSE_SCHEMAS) {
      expect(schemas.has(schema)).toBe(true);
    }
  });

  it("projects table applies its defaults and round-trips a row", async () => {
    const store = await freshStore();
    await store.run(
      "INSERT INTO platform.projects (id, name, domain) " +
        "VALUES ('p1', 'Loan Book', 'lending')",
    );
    const rows = await store.all(
      "SELECT id, name, domain, warehouse, created_at FROM platform.projects",
    );
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.id).toBe("p1");
    expect(row.name).toBe("Loan Book");
    expect(row.domain).toBe("lending");
    // NOT NULL DEFAULT 'duckdb' was applied even though we did not supply it.
    expect(row.warehouse).toBe("duckdb");
    // created_at default fired.
    expect(row.created_at).toBeTruthy();
  });

  it("enforces the projects primary key", async () => {
    const store = await freshStore();
    await store.run(
      "INSERT INTO platform.projects (id, name, domain) VALUES ('dup', 'A', 'x')",
    );
    await expect(
      store.run(
        "INSERT INTO platform.projects (id, name, domain) VALUES ('dup', 'B', 'y')",
      ),
    ).rejects.toThrow();
  });

  it("persists the warehouse to disk and creates its parent directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "datastack-store-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "nested", "warehouse.duckdb");

    const store = await freshStore(dbPath);
    expect(store.path).toBe(dbPath);
    // File exists on disk after open+migrate.
    await expect(stat(dbPath)).resolves.toBeTruthy();

    // Write a row, close, reopen — the schema and data survived the round-trip.
    await store.run(
      "INSERT INTO platform.projects (id, name, domain) VALUES ('r1', 'Persisted', 'lending')",
    );
    await store.close();
    open.splice(open.indexOf(store), 1);

    const reopened = await freshStore(dbPath);
    expect(await platformTableNames(reopened)).toEqual(new Set(PLATFORM_TABLES));
    const rows = await reopened.all(
      "SELECT name FROM platform.projects WHERE id = 'r1'",
    );
    expect(rows.map((r) => r.name)).toEqual(["Persisted"]);
  });
});
