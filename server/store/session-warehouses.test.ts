import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSessionWarehouseRegistry,
  sessionWarehouseDirectoryName,
  type SessionWarehouseRegistry,
} from "./session-warehouses.js";

describe("session warehouse registry", () => {
  const registries: SessionWarehouseRegistry[] = [];
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(registries.splice(0).map((registry) => registry.close()));
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function freshRegistry() {
    const root = await mkdtemp(join(tmpdir(), "session-warehouses-"));
    roots.push(root);
    const registry = createSessionWarehouseRegistry(root);
    registries.push(registry);
    return { root, registry };
  }

  it("gives equal table names independent data in different sessions", async () => {
    const { registry } = await freshRegistry();
    const alpha = await registry.get("ses_alpha");
    const beta = await registry.get("ses_beta");

    await alpha.run("CREATE TABLE marts.report AS SELECT 'alpha' AS owner");
    await beta.run("CREATE TABLE marts.report AS SELECT 'beta' AS owner");

    expect(await alpha.all("SELECT owner FROM marts.report")).toEqual([{ owner: "alpha" }]);
    expect(await beta.all("SELECT owner FROM marts.report")).toEqual([{ owner: "beta" }]);
  });

  it("reopens one session's persisted warehouse without exposing it to another", async () => {
    const { root, registry } = await freshRegistry();
    const alpha = await registry.get("ses_alpha");
    await alpha.run("CREATE TABLE durable AS SELECT 42 AS answer");
    await registry.close();
    registries.splice(registries.indexOf(registry), 1);

    const reopened = createSessionWarehouseRegistry(root);
    registries.push(reopened);
    expect(await (await reopened.get("ses_alpha")).all("SELECT answer FROM durable")).toEqual([
      { answer: 42 },
    ]);
    await expect((await reopened.get("ses_beta")).all("SELECT answer FROM durable")).rejects.toThrow(
      /durable/i,
    );
  });

  it("uses a stable path-safe directory and delete removes only that session", async () => {
    const { registry } = await freshRegistry();
    expect(sessionWarehouseDirectoryName("../ses alpha")).toMatch(/^_ses_alpha-[a-f0-9]{12}$/);

    const alpha = await registry.get("ses_alpha");
    const beta = await registry.get("ses_beta");
    await alpha.run("CREATE TABLE private_alpha AS SELECT 1 AS n");
    await beta.run("CREATE TABLE private_beta AS SELECT 1 AS n");
    await registry.delete("ses_alpha");

    await expect((await registry.get("ses_alpha")).all("SELECT * FROM private_alpha")).rejects.toThrow(
      /private_alpha/i,
    );
    expect(await beta.all("SELECT n FROM private_beta")).toEqual([{ n: 1 }]);
  });
});
