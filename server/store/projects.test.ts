import { afterEach, describe, expect, it } from "vitest";
import { openStore, type WarehouseStore } from "./duckdb.js";
import { insertProject, listProjects } from "./projects.js";
import { CreateProjectRequestSchema } from "../core/projects.js";

/**
 * Unit tests for the project store (T2.1, FR1). They assert the desired persisted
 * *values* — the generated id, the applied warehouse default, nullable optionals, the
 * newest-first ordering — not merely that the calls don't throw. They also prove the
 * writes are parameterized (a SQL-injection payload is stored as literal text, and the
 * table survives).
 */
describe("project store", () => {
  const open: WarehouseStore[] = [];

  afterEach(async () => {
    await Promise.all(open.splice(0).map((s) => s.close()));
  });

  async function freshStore(): Promise<WarehouseStore> {
    const store = await openStore(":memory:");
    open.push(store);
    return store;
  }

  /** Run the request through its schema so tests exercise the same shape the route does. */
  function req(input: unknown) {
    return CreateProjectRequestSchema.parse(input);
  }

  it("persists a project and returns it with a generated id and defaults", async () => {
    const store = await freshStore();
    const project = await insertProject(
      store,
      req({ name: "Loan Book", domain: "lending" }),
    );

    expect(project.id).toMatch(/[0-9a-f-]{36}/);
    expect(project.name).toBe("Loan Book");
    expect(project.domain).toBe("lending");
    // warehouse default applied by the schema and persisted.
    expect(project.warehouse).toBe("duckdb");
    // Optional descriptors default to null, not undefined or "".
    expect(project.expectedVolume).toBeNull();
    expect(project.servingStyle).toBeNull();
    // created_at was stamped by the table and read back as a string.
    expect(typeof project.createdAt).toBe("string");
    expect(project.createdAt.length).toBeGreaterThan(0);
  });

  it("round-trips the optional descriptors when supplied", async () => {
    const store = await freshStore();
    const project = await insertProject(
      store,
      req({
        name: "Ledger",
        domain: "finance",
        expectedVolume: "10M rows/day",
        servingStyle: "dashboard",
      }),
    );

    expect(project.expectedVolume).toBe("10M rows/day");
    expect(project.servingStyle).toBe("dashboard");

    // And the same values come back through the list read, not just the insert echo.
    const [listed] = await listProjects(store);
    expect(listed?.expectedVolume).toBe("10M rows/day");
    expect(listed?.servingStyle).toBe("dashboard");
  });

  it("lists projects newest first", async () => {
    const store = await freshStore();
    // Stamp created_at explicitly so ordering is deterministic regardless of clock ties.
    await store.run(
      "INSERT INTO platform.projects (id, name, domain, created_at) VALUES " +
        "('old', 'Older', 'lending', TIMESTAMP '2026-01-01 00:00:00'), " +
        "('new', 'Newer', 'lending', TIMESTAMP '2026-06-01 00:00:00')",
    );

    const projects = await listProjects(store);
    expect(projects.map((p) => p.id)).toEqual(["new", "old"]);
  });

  it("returns an empty list when there are no projects", async () => {
    const store = await freshStore();
    expect(await listProjects(store)).toEqual([]);
  });

  it("assigns a distinct id to each project", async () => {
    const store = await freshStore();
    const a = await insertProject(store, req({ name: "A", domain: "lending" }));
    const b = await insertProject(store, req({ name: "B", domain: "lending" }));
    expect(a.id).not.toBe(b.id);
    expect(await listProjects(store)).toHaveLength(2);
  });

  it("stores injection payloads as literal text (parameterized writes)", async () => {
    const store = await freshStore();
    const evil = "Robert'); DROP TABLE platform.projects;--";
    const project = await insertProject(store, req({ name: evil, domain: "lending" }));

    // The payload is stored verbatim, not executed…
    expect(project.name).toBe(evil);
    // …and the table is intact and still queryable afterwards.
    const projects = await listProjects(store);
    expect(projects.map((p) => p.name)).toContain(evil);
  });
});
