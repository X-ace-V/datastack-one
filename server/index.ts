import { buildServer } from "./app.js";
import { openStore } from "./store/duckdb.js";
import { createDatastackOpencode } from "./opencode/client.js";
import { createEventBridge } from "./opencode/bridge.js";
import { createEventHub } from "./opencode/hub.js";
import { createApprovalGate } from "./opencode/approvals.js";
import { createQuestionGate } from "./opencode/questions.js";
import { createToolApprovalGate } from "./opencode/tool-approvals.js";
import { createSessionDqGate } from "./opencode/session-dq.js";
import { createTranscriptPersister } from "./opencode/transcript.js";
import { SessionManager } from "./opencode/sessions.js";
import { testConnection } from "./connections/postgres.js";
import { attachPostgres } from "./connections/attach.js";
import { createSessionWarehouseRegistry } from "./store/session-warehouses.js";
import { createLocalWorkspaceService } from "./workspace/local.js";

/** Boot entrypoint: start the OpenCode runtime, then bind the HTTP server. */
const PORT = Number(process.env.PORT ?? 3001);
const HOST = process.env.HOST ?? "127.0.0.1";

async function main(): Promise<void> {
  // Open (and migrate) the metadata store so the project routes can persist to the
  // `platform` schema the moment HTTP starts accepting requests.
  const store = await openStore();
  const sessionWarehouses = createSessionWarehouseRegistry();
  const workspace = createLocalWorkspaceService();
  // Tell the agent-tools plugin (loaded into the OpenCode subprocess below) how to reach this
  // backend over loopback. The subprocess inherits this backend's env at spawn, so it must be
  // set BEFORE createDatastackOpencode. See server/tools/plugin.ts (ARCHITECTURE §3.4).
  process.env.DATASTACK_INTERNAL_URL ??= `http://${HOST}:${PORT}`;
  // Spawn the in-process OpenCode server first so its client is available to the
  // routes (e.g. `GET /api/models`) the moment HTTP starts accepting requests.
  const runtime = await createDatastackOpencode({ hostname: "127.0.0.1" });
  // Session metadata is created before the event pump so OpenCode-native title updates can be
  // mirrored into the durable sidebar index from the first event onward.
  const sessions = new SessionManager(runtime.client, store);
  // Capture permission requests into the approval gate (FR10). It is fed from the global event
  // bridge's single cross-directory pump below, so every folder-rooted runtime is observed.
  const approvals = createApprovalGate(runtime.client);
  // OpenCode's `question` tool blocks on a distinct reply/reject API. Capture it beside
  // permissions so the browser can render choices and resume the same folder-rooted session.
  const questions = createQuestionGate(runtime.v2Client);
  // Persist each assistant turn's blocks to `platform.messages` when the turn goes idle (V6.2),
  // so reopening a session reconstructs its full transcript. Fed off the same raw pump below.
  const transcript = createTranscriptPersister(store, {
    onError: (error) => console.error("transcript persist error:", error),
  });
  // Pump the runtime's global event stream once: raw events feed the permission gate and transcript
  // persister, while the bridge fans normalized chat events (text/reasoning/tool/idle/error) to
  // its subscribers.
  const bridge = createEventBridge(runtime.client, {
    onRawEvent: (event, { directory }) => {
      approvals.ingest(event, directory);
      questions.ingest(event, directory);
      transcript.ingest(event);
      if (event.type === "session.updated") {
        const info = event.properties.info;
        void sessions
          .syncRuntimeTitle(info.id, info.title)
          .catch((error) => console.error("session title sync error:", error));
      }
    },
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
  const app = buildServer({
    opencode: runtime.client,
    approvals,
    questions,
    toolApprovals,
    dqGate,
    store,
    sessionWarehouses,
    workspace,
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
    await sessionWarehouses.close();
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
