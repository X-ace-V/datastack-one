import { createOpencode, type OpencodeClient, type ServerOptions, type Config } from "@opencode-ai/sdk";
import { buildOpencodeConfig } from "./config.js";

/**
 * File URL of the DataStack One data-tools plugin (V3.1). OpenCode loads plugins by URL into
 * its own runtime; this points at `server/tools/plugin.ts`, resolved relative to this module so
 * it is correct under `tsx`/vitest (where modules run from source). The plugin is self-contained
 * and reaches this backend over loopback — see {@link file://../tools/plugin.ts}.
 */
export const DATASTACK_PLUGIN_URL = new URL("../tools/plugin.ts", import.meta.url).href;

/**
 * Merge the DataStack One tools plugin into a runtime {@link Config} (ARCHITECTURE §3.4).
 * The plugin is prepended so it always loads; any plugins the caller already listed are kept.
 * Pure so the wiring can be asserted without spawning the `opencode` server.
 */
export function withDatastackPlugins(config: Config): Config {
  return { ...config, plugin: [DATASTACK_PLUGIN_URL, ...(config.plugin ?? [])] };
}

/**
 * Boots the in-process OpenCode server that drives the agent runtime and returns a
 * connected SDK client plus a handle to stop it. This is the one place the platform
 * talks to `createOpencode`; routes, tools, and the bridge take the returned client.
 * See ARCHITECTURE §2, §3.3, §6.
 */

/** What a booted runtime exposes: the SDK client, the server URL, and a stop hook. */
export interface DatastackOpencode {
  /** SDK client bound to the running server (sessions, config, events, permissions). */
  client: OpencodeClient;
  /** Base URL the server is listening on (e.g. `http://127.0.0.1:4096`). */
  url: string;
  /** Stops the spawned `opencode` server process. Idempotent per the SDK. */
  close(): void;
}

/**
 * Default boot timeout. The SDK's own default is 5s, which is tight for a cold start
 * of the `opencode` binary (first-run initialization, provider discovery). 30s keeps
 * boot reliable without hanging a broken start forever.
 */
const DEFAULT_BOOT_TIMEOUT_MS = 30_000;

/**
 * Start the DataStack One OpenCode runtime.
 *
 * The secure defaults from {@link buildOpencodeConfig} (free default model +
 * `ask`-gated built-in mutation surfaces) are always applied; any `options.config`
 * the caller passes is merged on top via `buildOpencodeConfig`, so a test or a future
 * per-run override can adjust one field without discarding the gate.
 */
export async function createDatastackOpencode(
  options: ServerOptions = {},
): Promise<DatastackOpencode> {
  const { config, timeout, ...serverOptions } = options;
  const { client, server } = await createOpencode({
    ...serverOptions,
    timeout: timeout ?? DEFAULT_BOOT_TIMEOUT_MS,
    config: withDatastackPlugins(buildOpencodeConfig(config)),
  });
  return {
    client,
    url: server.url,
    close: () => server.close(),
  };
}
