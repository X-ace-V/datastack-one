import { buildServer } from "./app.js";
import { createDatastackOpencode } from "./opencode/client.js";
import { createRunBridge } from "./opencode/bridge.js";

/** Boot entrypoint: start the OpenCode runtime, then bind the HTTP server. */
const PORT = Number(process.env.PORT ?? 3001);
const HOST = process.env.HOST ?? "127.0.0.1";

async function main(): Promise<void> {
  // Spawn the in-process OpenCode server first so its client is available to the
  // routes (e.g. `GET /api/models`) the moment HTTP starts accepting requests.
  const runtime = await createDatastackOpencode({ hostname: "127.0.0.1" });
  // Start the progress bridge so it is pumping the event stream before any run begins.
  const bridge = createRunBridge(runtime.client, {
    onError: (error) => console.error("run event bridge error:", error),
  });
  const app = buildServer({ opencode: runtime.client, bridge });

  // Stop the bridge pump, then the spawned opencode process, when the HTTP server closes,
  // so a shutdown doesn't leave an orphaned subprocess or a dangling subscription.
  app.addHook("onClose", async () => {
    await bridge.close();
    runtime.close();
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
