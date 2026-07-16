import { buildServer } from "./app.js";
import { openStore } from "./store/duckdb.js";
import { createDatastackOpencode } from "./opencode/client.js";
import { createRunBridge } from "./opencode/bridge.js";
import { createApprovalGate } from "./opencode/approvals.js";

/** Boot entrypoint: start the OpenCode runtime, then bind the HTTP server. */
const PORT = Number(process.env.PORT ?? 3001);
const HOST = process.env.HOST ?? "127.0.0.1";

async function main(): Promise<void> {
  // Open (and migrate) the metadata store so the project routes can persist to the
  // `platform` schema the moment HTTP starts accepting requests.
  const store = await openStore();
  // Spawn the in-process OpenCode server first so its client is available to the
  // routes (e.g. `GET /api/models`) the moment HTTP starts accepting requests.
  const runtime = await createDatastackOpencode({ hostname: "127.0.0.1" });
  // Capture permission requests into the approval gate (FR8). It is fed from the run
  // bridge's single event pump below, so the runtime's event stream is read exactly once.
  const approvals = createApprovalGate(runtime.client);
  // Start the progress bridge so it is pumping the event stream before any run begins.
  const bridge = createRunBridge(runtime.client, {
    onEvent: (event) => approvals.ingest(event),
    onError: (error) => console.error("run event bridge error:", error),
  });
  const app = buildServer({
    opencode: runtime.client,
    planner: runtime.client,
    transformer: runtime.client,
    bridge,
    approvals,
    store,
  });

  // Stop the bridge pump, then the spawned opencode process, then close the store, when the
  // HTTP server closes, so a shutdown doesn't leave an orphaned subprocess, a dangling
  // subscription, or an open warehouse handle.
  app.addHook("onClose", async () => {
    await bridge.close();
    runtime.close();
    await store.close();
  });

  const address = await app.listen({ port: PORT, host: HOST });
  console.log(`DataStack One backend listening on ${address}`);

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      app.close().finally(() => process.exit(0));
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
