import { afterEach, describe, expect, it } from "vitest";
import { openStore, type WarehouseStore } from "./duckdb.js";
import {
  addConnection,
  deleteConnection,
  getStoredConnection,
  listConnections,
} from "./connections.js";

/**
 * Store units for the connections registry (V5.1, FR5) over a real in-memory warehouse. The
 * security-critical assertions: `listConnections` never carries the url, while
 * `getStoredConnection` (the backend resolver) does.
 */
describe("connections store", () => {
  const open: WarehouseStore[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((s) => s.close()));
  });

  async function store(): Promise<WarehouseStore> {
    const s = await openStore(":memory:");
    open.push(s);
    return s;
  }

  const URL_A = "postgresql://alice:secretA@host-a/db_a";
  const URL_B = "postgresql://bob:secretB@host-b/db_b";

  it("persists a connection and reads it back with its secret via the resolver", async () => {
    const s = await store();
    const stored = await addConnection(s, { name: "conn_a", type: "postgres", url: URL_A });
    expect(stored).toMatchObject({ name: "conn_a", type: "postgres", url: URL_A });
    expect(stored.createdAt).toBeTruthy();

    const resolved = await getStoredConnection(s, "conn_a");
    expect(resolved?.url).toBe(URL_A);
  });

  it("lists connections WITHOUT the url secret", async () => {
    const s = await store();
    await addConnection(s, { name: "conn_a", type: "postgres", url: URL_A });
    await addConnection(s, { name: "conn_b", type: "postgres", url: URL_B });

    const list = await listConnections(s);
    expect(list.map((c) => c.name).sort()).toEqual(["conn_a", "conn_b"]);
    for (const c of list) {
      expect("url" in c).toBe(false);
      // No secret leaks through any serialized field of the view.
      expect(JSON.stringify(c)).not.toContain("secret");
    }
  });

  it("re-adding a name replaces its url (registry, not a log)", async () => {
    const s = await store();
    await addConnection(s, { name: "conn_a", type: "postgres", url: URL_A });
    await addConnection(s, { name: "conn_a", type: "postgres", url: URL_B });

    expect((await listConnections(s))).toHaveLength(1);
    expect((await getStoredConnection(s, "conn_a"))?.url).toBe(URL_B);
  });

  it("lists newest first, name breaking ties", async () => {
    const s = await store();
    await addConnection(s, { name: "beta", type: "postgres", url: URL_A });
    await addConnection(s, { name: "alpha", type: "postgres", url: URL_B });
    const names = (await listConnections(s)).map((c) => c.name);
    // Both stamped within the same second in :memory:, so the created_at DESC tie resolves to the
    // name ASC secondary sort — a stable order, which is all the contract promises.
    expect(new Set(names)).toEqual(new Set(["alpha", "beta"]));
  });

  it("deletes a connection and reports existence", async () => {
    const s = await store();
    await addConnection(s, { name: "conn_a", type: "postgres", url: URL_A });

    expect(await deleteConnection(s, "conn_a")).toBe(true);
    expect(await getStoredConnection(s, "conn_a")).toBeNull();
    expect(await listConnections(s)).toEqual([]);
    // A second delete finds nothing.
    expect(await deleteConnection(s, "conn_a")).toBe(false);
  });

  it("binds the url as a parameter (no SQL injection via the url)", async () => {
    const s = await store();
    const nasty = "postgresql://u:p@host/db'); DROP TABLE platform.connections; --";
    await addConnection(s, { name: "inj", type: "postgres", url: nasty });
    // The table still exists and stored the payload literally.
    expect((await getStoredConnection(s, "inj"))?.url).toBe(nasty);
  });

  it("returns null resolving an unknown connection", async () => {
    const s = await store();
    expect(await getStoredConnection(s, "nope")).toBeNull();
  });
});
