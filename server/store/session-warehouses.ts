import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { openStore, type WarehouseStore } from "./duckdb.js";

/** Default root for session-owned execution warehouses. The control DB remains separate. */
export const DEFAULT_SESSION_WAREHOUSES_DIR = "data/sessions";

/**
 * A lazy pool of isolated DuckDB stores. Different sessions never share a connection, catalog,
 * raw/staging/marts schemas, or attached external database. A single session reuses its own
 * connection so its tables survive across tool calls and can be reopened after an app restart.
 */
export interface SessionWarehouseRegistry {
  get(sessionId: string): Promise<WarehouseStore>;
  delete(sessionId: string): Promise<void>;
  close(): Promise<void>;
}

/** Stable filesystem-safe directory name without trusting an OpenCode id as a path segment. */
export function sessionWarehouseDirectoryName(sessionId: string): string {
  const readable = sessionId.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 48) || "session";
  const digest = createHash("sha256").update(sessionId).digest("hex").slice(0, 12);
  return `${readable}-${digest}`;
}

export function createSessionWarehouseRegistry(
  root: string = DEFAULT_SESSION_WAREHOUSES_DIR,
): SessionWarehouseRegistry {
  const stores = new Map<string, Promise<WarehouseStore>>();
  let closed = false;

  const pathFor = (sessionId: string) =>
    join(root, sessionWarehouseDirectoryName(sessionId), "warehouse.duckdb");

  return {
    async get(sessionId) {
      if (closed) throw new Error("session warehouse registry is closed");
      let pending = stores.get(sessionId);
      if (!pending) {
        pending = openStore(pathFor(sessionId));
        stores.set(sessionId, pending);
        pending.catch(() => stores.delete(sessionId));
      }
      return pending;
    },

    async delete(sessionId) {
      const pending = stores.get(sessionId);
      stores.delete(sessionId);
      if (pending) await (await pending).close();
      // The exact target is derived from a hash and always below the configured root.
      await rm(join(root, sessionWarehouseDirectoryName(sessionId)), {
        recursive: true,
        force: true,
      });
    },

    async close() {
      if (closed) return;
      closed = true;
      const pending = [...stores.values()];
      stores.clear();
      await Promise.all(pending.map(async (store) => (await store).close()));
    },
  };
}
