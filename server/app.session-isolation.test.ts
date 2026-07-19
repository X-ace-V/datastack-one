import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "./app.js";
import { openStore, type WarehouseStore } from "./store/duckdb.js";
import { insertSession } from "./store/sessions.js";
import { registerSessionSource } from "./store/session-sources.js";
import {
  createSessionWarehouseRegistry,
  type SessionWarehouseRegistry,
} from "./store/session-warehouses.js";
import { createToolApprovalGate, type ToolApprovalGate } from "./opencode/tool-approvals.js";

describe("chat execution isolation", () => {
  const stores: WarehouseStore[] = [];
  const registries: SessionWarehouseRegistry[] = [];
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(registries.splice(0).map((registry) => registry.close()));
    await Promise.all(stores.splice(0).map((store) => store.close()));
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("keeps same-named sources, warehouse tables, transforms, and endpoints independent", async () => {
    const store = await openStore(":memory:");
    stores.push(store);
    await insertSession(store, { id: "ses_alpha", title: "Alpha" });
    await insertSession(store, { id: "ses_beta", title: "Beta" });

    const root = await mkdtemp(join(tmpdir(), "session-isolation-"));
    dirs.push(root);
    const alphaCsv = join(root, "alpha.csv");
    const betaCsv = join(root, "beta.csv");
    await writeFile(alphaCsv, "owner,value\nalpha,1\n");
    await writeFile(betaCsv, "owner,value\nbeta,2\n");
    await registerSessionSource(store, {
      sessionId: "ses_alpha",
      name: "input",
      path: alphaCsv,
      origin: "upload",
    });
    await registerSessionSource(store, {
      sessionId: "ses_beta",
      name: "input",
      path: betaCsv,
      origin: "upload",
    });

    const warehouses = createSessionWarehouseRegistry(join(root, "warehouses"));
    registries.push(warehouses);
    let gate: ToolApprovalGate;
    gate = createToolApprovalGate((event) => {
      if (event.kind === "approval") queueMicrotask(() => gate.reply(event.requestID, "approve"));
    });
    const app = buildServer({
      store,
      sessionWarehouses: warehouses,
      toolApprovals: gate,
      landingDir: join(root, "landing"),
      servingDir: join(root, "serving"),
    });

    for (const sessionID of ["ses_alpha", "ses_beta"]) {
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/internal/tools/land_parquet",
            payload: { sessionID, source: "input", ingestionDate: "2026-07-19" },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/internal/tools/load_warehouse",
            payload: { sessionID, dataset: "input" },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/internal/tools/run_transform",
            payload: {
              sessionID,
              sql: "CREATE OR REPLACE TABLE marts.report AS SELECT owner, value FROM raw.source",
              targetTable: "report",
            },
          })
        ).statusCode,
      ).toBe(200);
    }

    const alphaQuery = await app.inject({
      method: "POST",
      url: "/api/internal/tools/run_query",
      payload: { sessionID: "ses_alpha", sql: "SELECT owner, value FROM marts.report" },
    });
    const betaQuery = await app.inject({
      method: "POST",
      url: "/api/internal/tools/run_query",
      payload: { sessionID: "ses_beta", sql: "SELECT owner, value FROM marts.report" },
    });
    expect(alphaQuery.json().result.rows).toEqual([{ owner: "alpha", value: 1 }]);
    expect(betaQuery.json().result.rows).toEqual([{ owner: "beta", value: 2 }]);

    const alphaPublish = await app.inject({
      method: "POST",
      url: "/api/internal/tools/publish_serving",
      payload: { sessionID: "ses_alpha", table: "report", name: "report" },
    });
    const betaPublish = await app.inject({
      method: "POST",
      url: "/api/internal/tools/publish_serving",
      payload: { sessionID: "ses_beta", table: "report", name: "report" },
    });
    expect(alphaPublish.statusCode).toBe(200);
    expect(betaPublish.statusCode).toBe(200);
    expect(alphaPublish.json().name).toBe("ses_alpha-report");
    expect(betaPublish.json().name).toBe("ses_beta-report");

    const alphaServed = await app.inject({ method: "GET", url: alphaPublish.json().endpoint });
    const betaServed = await app.inject({ method: "GET", url: betaPublish.json().endpoint });
    expect(alphaServed.json().rows).toEqual([{ owner: "alpha", value: 1 }]);
    expect(betaServed.json().rows).toEqual([{ owner: "beta", value: 2 }]);
  });
});
