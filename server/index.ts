import { buildServer } from "./app.js";
import { openStore } from "./store/duckdb.js";
import { createDatastackOpencode } from "./opencode/client.js";
import { createEventBridge } from "./opencode/bridge.js";
import { createEventHub } from "./opencode/hub.js";
import { createApprovalGate } from "./opencode/approvals.js";
import { createToolApprovalGate } from "./opencode/tool-approvals.js";
import { createSessionDqGate } from "./opencode/session-dq.js";
import { SessionManager } from "./opencode/sessions.js";
import { testConnection } from "./connections/postgres.js";
import { attachPostgres } from "./connections/attach.js";

/** Boot entrypoint: start the OpenCode runtime, then bind the HTTP server. */
const PORT = Number(process.env.PORT ?? 3001);
const HOST = process.env.HOST ?? "127.0.0.1";

async function main(): Promise<void> {
  // Open (and migrate) the metadata store so the project routes can persist to the
  // `platform` schema the moment HTTP starts accepting requests.
  const store = await openStore();
  // Tell the agent-tools plugin (loaded into the OpenCode subprocess below) how to reach this
  // backend over loopback. The subprocess inherits this backend's env at spawn, so it must be
  // set BEFORE createDatastackOpencode. See server/tools/plugin.ts (ARCHITECTURE §3.4).
  process.env.DATASTACK_INTERNAL_URL ??= `http://${HOST}:${PORT}`;
  // Spawn the in-process OpenCode server first so its client is available to the
  // routes (e.g. `GET /api/models`) the moment HTTP starts accepting requests.
  const runtime = await createDatastackOpencode({ hostname: "127.0.0.1" });
  // Capture permission requests into the approval gate (FR10). It is fed from the event
  // bridge's single pump below, so the runtime's event stream is read exactly once.
  const approvals = createApprovalGate(runtime.client);
  // Pump the runtime's event stream once: raw events feed the permission gate, while the
  // bridge fans normalized chat events (text/reasoning/tool/idle/error) to its subscribers.
  const bridge = createEventBridge(runtime.client, {
    onRawEvent: (event) => approvals.ingest(event),
    onError: (error) => console.error("event bridge error:", error),
  });
  // Sequence the normalized stream into a per-session, replayable SSE fan-out (FR3) that the
  // chat UI subscribes to over `GET /api/events`.
  const events = createEventHub(bridge);
  // The write-tool approval gate (FR8/FR10): OpenCode does not gate custom plugin tools, so each
  // write route pauses on this gate before executing. It surfaces each pending approval inline by
  // publishing onto the same SSE stream, so the chat's approval pill renders it.
  const toolApprovals = createToolApprovalGate((event) => events.publish(event));
  // The per-session DQ gate (FR9): `run_dq_check` records each run here and `publish_serving`
  // refuses to publish for a session whose most recent DQ run failed, until it passes again.
  const dqGate = createSessionDqGate();
  // Orchestrate chat sessions over the runtime + store (FR1) so the session routes can
  // create/list/get/rename/delete conversations.
  const sessions = new SessionManager(runtime.client, store);
  const app = buildServer({
    opencode: runtime.client,
    approvals,
    toolApprovals,
    dqGate,
    store,
    sessions,
    events,
    testConnection,
    attachSource: attachPostgres,
  });

  // Stop the bridge pump, then the spawned opencode process, then close the store, when the
  // HTTP server closes, so a shutdown doesn't leave an orphaned subprocess, a dangling
  // subscription, or an open warehouse handle.
  app.addHook("onClose", async () => {
    events.close();
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
