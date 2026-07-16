import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { openStore, type WarehouseStore } from "./duckdb.js";
import { insertProject } from "./projects.js";
import { insertSource, listSources } from "./sources.js";

/**
 * Unit tests for the source store (T2.2, FR2). They assert the desired persisted *values* —
 * the applied `kind` default, the null `row_count` before profiling, and the newest-first
 * ordering scoped to one project — not merely that the calls don't throw.
 */
describe("source store", () => {
  const open: WarehouseStore[] = [];

  afterEach(async () => {
    await Promise.all(open.splice(0).map((s) => s.close()));
  });

  async function storeWithProject(): Promise<{
    store: WarehouseStore;
    projectId: string;
  }> {
    const store = await openStore(":memory:");
    open.push(store);
    const project = await insertProject(store, {
      name: "Loan Book",
      domain: "lending",
      warehouse: "duckdb",
    });
    return { store, projectId: project.id };
  }

  it("persists a source with the csv default and a null row count", async () => {
    const { store, projectId } = await storeWithProject();
    const source = await insertSource(store, {
      id: randomUUID(),
      projectId,
      path: "data/uploads/p/s-loans.csv",
      originalFilename: "loans.csv",
    });

    expect(source.id).toMatch(/[0-9a-f-]{36}/);
    expect(source.projectId).toBe(projectId);
    expect(source.kind).toBe("csv");
    expect(source.path).toBe("data/uploads/p/s-loans.csv");
    expect(source.originalFilename).toBe("loans.csv");
    expect(source.rowCount).toBeNull();
    expect(source.createdAt).toBeTruthy();
  });

  it("lists a project's sources newest first and scopes to that project", async () => {
    const { store, projectId } = await storeWithProject();
    const other = await insertProject(store, {
      name: "Other",
      domain: "lending",
      warehouse: "duckdb",
    });

    const first = await insertSource(store, {
      id: randomUUID(),
      projectId,
      path: "a.csv",
      originalFilename: "a.csv",
    });
    const second = await insertSource(store, {
      id: randomUUID(),
      projectId,
      path: "b.csv",
      originalFilename: "b.csv",
    });
    await insertSource(store, {
      id: randomUUID(),
      projectId: other.id,
      path: "c.csv",
      originalFilename: "c.csv",
    });

    const listed = await listSources(store, projectId);
    // Only this project's sources, newest first.
    expect(listed.map((s) => s.id)).toEqual([second.id, first.id]);
    expect(listed.every((s) => s.projectId === projectId)).toBe(true);
  });

  it("stores an unnamed upload with a null original filename", async () => {
    const { store, projectId } = await storeWithProject();
    const source = await insertSource(store, {
      id: randomUUID(),
      projectId,
      path: "data/uploads/p/s-upload.csv",
      originalFilename: null,
    });
    expect(source.originalFilename).toBeNull();
  });
});
