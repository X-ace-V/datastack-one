import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatastackOpencode, type DatastackOpencode } from "./client.js";

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
