# DataStack One API

DataStack One's browser uses this REST and SSE surface. The `internal/tools/*` routes are loopback
calls from OpenCode's separate plugin runtime; they are documented for transparency and are not a
public remote API.

| Route | Purpose |
|---|---|
| `GET /api/health` | Liveness. |
| `GET /api/models` | Live model catalog. |
| `POST /api/sessions` · `GET /api/sessions` | Create or list chat sessions; creation accepts an optional immutable `folderPath`. |
| `GET /api/sessions/status` | Recover the live status map for background chats. |
| `GET /api/sessions/:id` | Load a session and message history. |
| `GET /api/sessions/:id/lineage` | Read write calls, approvals, and DQ results. |
| `PATCH /api/sessions/:id` · `DELETE /api/sessions/:id` | Rename or delete a session. |
| `POST /api/sessions/:id/chat` · `POST /api/sessions/:id/cancel` | Send or cancel a turn. |
| `POST /api/sessions/:id/sources` · `GET /api/sessions/:id/sources` | Upload or list session-owned files. |
| `GET /api/folders` | Browse server-approved local folders. |
| `GET /api/sessions/:id/folder` | Read a session's immutable workspace and indexed files. |
| `POST /api/sessions/:id/folder` · `DELETE /api/sessions/:id/folder` | Compatibility guards; changing an existing runtime's cwd returns `409`. |
| `POST /api/sessions/:id/folder/refresh` | Rescan a connected folder. |
| `GET /api/events` | Replayable, per-session SSE stream. |
| `GET /api/interactions` | Recover pending approvals and agent questions. |
| `POST /api/connections` · `GET /api/connections` | Register or list connection names; secrets are never returned. |
| `DELETE /api/connections/:name` | Remove a connection. |
| `POST /api/connections/:name/test` | Test a connection read-only. |
| `POST /api/projects` · `GET /api/projects` | Create or list project records used by the data engine. |
| `POST /api/projects/:id/source` · `GET /api/projects/:id/sources` | Upload or list project CSV sources. |
| `POST /api/projects/:id/profile` | Profile a source. |
| `POST /api/projects/:id/rules` · `GET /api/projects/:id/rules` | Save or read a rules document. |
| `GET /api/projects/:id/artifacts` | Read the latest generated artifact per kind. |
| `POST /api/approvals/:requestID` | Answer an agent or custom-tool approval. |
| `POST /api/questions/:requestID` | Answer or reject an interactive agent question. |
| `GET /api/projects/:id/served` | List endpoints published for a project. |
| `GET /api/serve/:name` · `GET /api/serve/:name.csv` | Read a snapshot as JSON or CSV. |
| `POST /api/internal/tools/list_sources` · `POST /api/internal/tools/profile_source` · `POST /api/internal/tools/run_query` | Loopback read tools. |
| `POST /api/internal/tools/list_workspace_files` · `POST /api/internal/tools/read_workspace_file` | Loopback workspace listing and bounded reads. |
| `POST /api/internal/tools/write_workspace_file` | Loopback approval-gated workspace write. |
| `POST /api/internal/tools/run_dq_check` | Loopback data-quality execution. |
| `POST /api/internal/tools/land_parquet` · `POST /api/internal/tools/load_warehouse` · `POST /api/internal/tools/run_transform` · `POST /api/internal/tools/publish_serving` | Loopback approval-gated data writes. |
| `POST /api/internal/tools/attach_source` | Loopback approval-gated, name-only Postgres attachment. |
