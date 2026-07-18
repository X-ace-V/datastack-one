import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDatastackOpencode,
  withDatastackPlugins,
  DATASTACK_PLUGIN_URL,
  type DatastackOpencode,
} from "./client.js";

/**
 * Pure wiring tests for the data-tools plugin registration (V3.1). No `opencode` boot needed —
 * these assert the config the runtime is given carries the plugin so the agent's tools load.
 */
describe("data-tools plugin wiring", () => {
  it("points the plugin URL at server/tools/plugin.ts as a file URL", () => {
    expect(DATASTACK_PLUGIN_URL).toMatch(/^file:\/\//);
    expect(DATASTACK_PLUGIN_URL).toMatch(/\/tools\/plugin\.ts$/);
  });

  it("prepends the plugin to the runtime config, keeping any caller plugins", () => {
    expect(withDatastackPlugins({}).plugin).toEqual([DATASTACK_PLUGIN_URL]);
    expect(withDatastackPlugins({ plugin: ["other-plugin"] }).plugin).toEqual([
      DATASTACK_PLUGIN_URL,
      "other-plugin",
    ]);
  });

  it("preserves the rest of the config untouched", () => {
    const merged = withDatastackPlugins({ model: "opencode/big-pickle" });
    expect(merged.model).toBe("opencode/big-pickle");
  });
});

/**
 * Boot + health test for the OpenCode runtime (T1.1). This actually spawns the
 * in-process `opencode` server via `createDatastackOpencode`, then probes it live:
 * the server must report the free default model we configured, and must answer an
 * app query — proving the runtime booted, applied our config, and is reachable.
 *
 * A real subprocess boot is slow relative to unit tests, so it runs once for the
 * suite with a generous timeout. A non-default port avoids clashing with a dev
 * runtime on 4096.
 */
describe("createDatastackOpencode boot + health", () => {
  let runtime: DatastackOpencode;

  beforeAll(async () => {
    runtime = await createDatastackOpencode({ hostname: "127.0.0.1", port: 4771 });
  }, 60_000);

  afterAll(() => {
    runtime?.close();
  });

  it("boots a reachable server on the configured host/port", () => {
    expect(runtime.url).toBe("http://127.0.0.1:4771");
  });

  it("applies the free default model to the running server", async () => {
    const cfg = await runtime.client.config.get();
    expect(cfg.error).toBeUndefined();
    expect(cfg.data?.model).toBe("opencode/big-pickle");
  });

  it("applies the ask permission gate to the running server", async () => {
    const cfg = await runtime.client.config.get();
    expect(cfg.data?.permission).toMatchObject({
      edit: "ask",
      bash: "ask",
      webfetch: "ask",
    });
  });

  it("responds to a live app query (health probe)", async () => {
    const agents = await runtime.client.app.agents();
    expect(agents.error).toBeUndefined();
    expect(Array.isArray(agents.data)).toBe(true);
    expect(agents.data!.length).toBeGreaterThan(0);
  });
});
