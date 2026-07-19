import type { WarehouseStore } from "./duckdb.js";
import { SessionFolderSchema, type SessionFolder } from "../core/workspace.js";

const COLUMNS =
  "session_id, name, path, workspace_root, CAST(connected_at AS VARCHAR) AS connected_at";

function rowToFolder(row: Record<string, unknown>): SessionFolder {
  return SessionFolderSchema.parse({
    sessionId: row.session_id,
    name: row.name,
    path: row.path,
    workspaceRoot: row.workspace_root,
    connectedAt: row.connected_at,
  });
}

export async function connectSessionFolder(
  store: WarehouseStore,
  input: { sessionId: string; name: string; path: string; workspaceRoot: boolean },
): Promise<SessionFolder> {
  await store.run(
    `INSERT INTO platform.session_folders (session_id, name, path, workspace_root)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (session_id) DO UPDATE SET
       name = excluded.name, path = excluded.path,
       workspace_root = excluded.workspace_root, connected_at = now()`,
    [input.sessionId, input.name, input.path, input.workspaceRoot],
  );
  const folder = await getSessionFolder(store, input.sessionId);
  if (!folder) throw new Error(`session folder ${input.sessionId} missing after connect`);
  return folder;
}

/** List folder metadata for all sessions, used to address directory-scoped OpenCode APIs. */
export async function listSessionFolders(store: WarehouseStore): Promise<SessionFolder[]> {
  const rows = await store.all(`SELECT ${COLUMNS} FROM platform.session_folders`);
  return rows.map(rowToFolder);
}

export async function getSessionFolder(
  store: WarehouseStore,
  sessionId: string,
): Promise<SessionFolder | null> {
  const rows = await store.all(
    `SELECT ${COLUMNS} FROM platform.session_folders WHERE session_id = $1`,
    [sessionId],
  );
  return rows[0] ? rowToFolder(rows[0]) : null;
}

export async function disconnectSessionFolder(
  store: WarehouseStore,
  sessionId: string,
): Promise<void> {
  await store.run("DELETE FROM platform.session_folders WHERE session_id = $1", [sessionId]);
}
