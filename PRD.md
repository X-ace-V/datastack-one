# DataStack One — Engineering PRD (v2: Conversational Agent)

Last updated: 2026-07-19
Status: **implemented** · supersedes the v1 wizard PRD

This is the **contract** the build obeys. Product vision:
[`PRD_DataStack_One.md`](./PRD_DataStack_One.md). Technical design:
[`ARCHITECTURE.md`](./ARCHITECTURE.md). Loop rules: [`LOOP.md`](./LOOP.md).

> **Why a v2.** v1 shipped a 6-step button wizard with a deterministic runner. That is the
> wrong product. DataStack One is a **conversational, session-based data-engineering agent**
> — like Claude Code / Crux — where the user talks in natural language, connects data
> sources, and an agent does the work by calling tools live, with approvals inline. The
> agent **is** the interface. The v1 engine (OpenCode wiring, data tools, DuckDB) is reused;
> the wizard shell and the deterministic runner are removed.

---

## 1. Goal

A local web app where a user opens a **chat session**, attaches files or connects an existing
local data-project folder (plus optional live Postgres), and **asks in plain English** —
*"profile this,"* *"which branch has the most
overdue loans,"* *"clean it and publish a daily branch report as an API."* An **agent**
plans and executes by calling data tools, **streaming every step** (reasoning + tool calls)
into the chat, **pausing inline for approval** before any write. The user can run **many
sessions** for different work and switch between them without interrupting work already running.

"Production enough": real OpenCode agent, real DuckDB, real Postgres, real tool execution,
real approval gating — driven entirely by conversation.

---

## 2. In scope (MVP)

- **Sessions** — create / list / switch / rename / delete; each is its own OpenCode session and
  isolated execution warehouse. OpenCode generates the first-prompt title; title/status events
  update the sidebar. Messages + metadata persist so a session reopens with its history.
- **Chat** — NL input; streamed assistant text, reasoning, and **tool-call cards** (name +
  args + status + result); cancel a turn; per-session model, draft, attachment queue, folder,
  and background-running state. Switching the visible chat does not abort its turn.
- **Connections (settings, not chat)** — a **Settings → Connections** panel is the *only*
  place a database URL is entered: add / test / remove a Postgres (Neon) connection by name.
  The secret is stored **server-side and gitignored**, never in chat, history, or the model.
- **Data sources** — per session: composer-only **multi-file upload** (CSV/TSV/JSON/JSONL/
  Parquet plus SQL/YAML/Markdown/text project files), one connected existing local folder, and
  **registered Postgres connections**. Folder paths stay backend-side; the agent sees supported
  relative paths, with secrets/generated directories/symlinks excluded.
  DuckDB is the query engine; a registered Postgres is ATTACHed **read-only** by name, so the
  agent queries files and live tables together. **The agent references a source by its name
  and sees its schema — never the raw URL or password.**
- **Agent tools** (the agent calls these conversationally):
  - read-only: `list_sources` (by name + schema), `profile_source`, `run_query` (SELECT over
    DuckDB + attached Postgres), `list_workspace_files`, `read_workspace_file`. Connecting a
    database is a **settings action**, not an agent tool — the agent never handles credentials.
  - write (permission `ask`): `land_parquet`, `load_warehouse`, `run_transform`,
    `publish_serving`, `write_workspace_file`.
- **Ad-hoc querying is first-class** — `run_query` returns a table to the data panel; asking
  questions of the data is a primary use, not just pipeline building.
- **Inline approvals** — every write tool pauses the turn with an Allow/Deny in the chat,
  showing the exact SQL/DDL. Reject aborts that action. Nothing writes unapproved.
- **Serving** — the agent can publish a mart as a REST endpoint + CSV (reused from v1).
- **History / lineage** — per session: the message history, and per run the tool calls,
  approvals, and DQ results.
- **Model routing** — default free `opencode/big-pickle`; live model list; per-session pick.

## 3. Out of scope (MVP non-goals)

Electron / desktop packaging · auth / multi-user · non-Postgres databases · MCP-based
connectors (deferred; the plugin/tool seam is left for them) · scheduling / CDC / streaming ·
the v1 deterministic pipeline runner (removed) · real customer data (synthetic fixtures only)
· writing to Postgres (connection is read-only).

---

## 4. Functional requirements

- **FR1 — Sessions.** `POST/GET/PATCH/DELETE` sessions; each maps to an OpenCode session and
  private data-plane DuckDB. Messages + metadata persist in the control DB. OpenCode is canonical
  for generated titles; live title/status updates drive the sidebar. Switching loads that chat's
  history/draft/files and never cancels another chat's active turn.
- **FR2 — Chat turn.** `POST /api/sessions/:id/chat` sends an NL prompt via `session.prompt`;
  returns fast; the answer streams over SSE. `POST …/cancel` aborts.
- **FR3 — Event stream.** `GET /api/events` (SSE) relays OpenCode's cross-directory
  `/global/event` stream —
  assistant text deltas, reasoning, tool calls (with status), and turn-idle — scoped per
  session, with a replay buffer for reconnect.
- **FR4 — Session files and folder.** The attachment control exists only inside the composer and
  accepts multiple supported files per selection. Each upload and working folder is owned by
  one session. A server-backed local picker starts a new independent OpenCode session with the
  chosen folder as its immutable working directory; selecting another folder starts another
  session instead of relabeling an existing runtime. Refresh rescans it.
  Queryable data files are registered in that session's private DuckDB; project text files can be
  listed/read by relative path. Absolute paths and sensitive files never reach the model.
- **FR5 — Connections (settings).** A Settings → Connections panel adds / tests / removes
  Postgres (Neon) connections by name. The URL is entered only here; the secret is stored
  **server-side and gitignored**, never in chat, message history, or a model prompt.
  `POST/GET/DELETE /api/connections` + a test-connection call; the API never returns secrets.
- **FR5b — Postgres access by name.** A registered connection is ATTACHed **read-only** via
  DuckDB's postgres extension; its tables become queryable alongside files. **The agent sees
  the connection name + schema only; the backend resolves name → URL when running SQL, so the
  credential never reaches the model, the chat, or any tool argument the model produces.**
- **FR6 — Profiling.** `profile_source` returns schema, types, row count, null %, candidate
  keys, date columns for any connected source.
- **FR7 — NL query.** `run_query` executes a read-only SELECT (DuckDB, spanning attached
  Postgres) and returns rows to the data panel. Ad-hoc questions work end to end.
- **FR8 — Build via tools.** The agent lands Parquet, loads `raw`/`staging`, and runs
  transform SQL into `marts` by calling the write tools — orchestrated by the conversation,
  not a fixed pipeline.
- **FR9 — Data quality.** The agent can generate + run DQ checks (row count, null, schema,
  freshness); a failed check blocks a subsequent publish.
- **FR10 — Inline approval gate.** `land_parquet`, `load_warehouse`, `run_transform`,
  `publish_serving`, and `write_workspace_file` are permission `ask`; each surfaces inline in the chat with the exact
  SQL; answered via `POST /api/approvals/:requestID`. 100% of writes approved before running.
- **FR11 — Serving.** `publish_serving` registers a served table → `GET /api/serve/:name`
  (JSON) + `/api/serve/:name.csv` (download).
- **FR12 — Data panel.** A side panel renders the current source schema, query results, and
  published endpoints — the "computer" view alongside the chat.
- **FR13 — Model routing.** `GET /api/models`; default `opencode/big-pickle`; per-session
  model selection; paid tiers appear only when a provider key is in the environment.
- **FR14 — Concurrent independence.** Equal source, table, transform, or served-report names in
  different chats cannot collide. Turns continue in OpenCode and stream globally while inactive;
  reconnect recovers the runtime status map and per-session history.

---

## 5. Acceptance criteria

The MVP is "done" when **all** hold, on synthetic fixtures + a local Postgres:

- [x] A user can **create multiple sessions** and switch between them, each keeping its own
      history, draft, files, folder, execution warehouse, and background status.
- [x] From the composer, **upload one or more files or start a session in an existing folder**;
      the agent's actual cwd is that selected folder, not the DataStack application repository.
      Ask a question in plain English, and get a correct
      table back** in the panel (`run_query`) — no buttons per step.
- [x] **Connect a local Postgres** and query its tables (and join a CSV to a PG table) via NL.
- [x] Ask the agent to **build and publish a daily branch report**; it profiles, writes SQL,
      **pauses inline for approval on each write**, runs it, and exposes a REST endpoint —
      all in conversation.
- [x] **100% of write tools required an inline approval** before executing (verified from the
      lineage/audit trail).
- [x] Tool calls **stream live** in the chat (reasoning + tool cards with status).
- [x] The whole flow **completes on the free `opencode/big-pickle`** at least once (upgrading
      to a paid model is allowed if the free model cannot hold tool orchestration — record it).

---

## 6. Engineering standards

Unchanged from v1: TypeScript strict, ESM NodeNext (server relative imports end in `.js`);
`server/core` pure; **no stubs**; zod validation; synthetic fixtures only, never real data
through a free model; gate = full `npm test` + `npm run typecheck` green before check-off;
conventional commits ≤72-char imperative subject, **no trailers, no AI attribution**; one
logical change per commit. Full detail: [`LOOP.md`](./LOOP.md).

---

## 7. Risks & mitigations

| Risk | Mitigation |
|------|-----------|
| Free model too weak for multi-step tool orchestration | Constrained tool set + clear tool descriptions; one-click switch to a paid model; record which model completed the demo. |
| Agent nondeterminism (it's now driving, not a fixed runner) | Tools are the only way to touch data; writes are `ask`-gated; read-only query can't mutate. The agent chooses *order*, not *capabilities*. |
| Postgres access unsafe / credential leak | Connection is **read-only** (ATTACH read_only); the URL lives in a gitignored server-side store entered via Settings only; the agent references sources by **name**, never the secret — so no credential enters chat, history, or the model. Use a synthetic Neon DB for the MVP, never production. |
| SSE streaming / reconnect complexity | Mirror Crux's proven pattern: per-session event routing + monotonic-seq replay buffer. |
| Sessions overwrite each other's warehouse state | Keep one control DB for metadata and a lazy on-disk DuckDB catalog per OpenCode session; session-scope public report names. |
| Local folder exposes secrets or escapes its root | Canonical-path containment, localhost/CSRF checks, no symlink traversal, hidden/generated/sensitive exclusions, bounded reads, relative model-facing paths, and approval-gated writes. |
| "Looks like a chatbot" | The data panel, live tool cards, inline approvals, and a real served endpoint make it a platform, not a chat answer. |

---

## 8. Reference blueprint

The build mirrors two working OpenCode apps in this workspace:
`/Users/parker/workspace/opencode-cowork` (backend: embeds OpenCode, session manager, tools
as a plugin, `global.event`→SSE, `permission.asked` bridge) and
`/Users/parker/workspace/crux-frontend-rebrand` (React chat: per-session live store, SSE
hook, inline tool/reasoning/approval rendering, session sidebar). We reuse those patterns,
sized down for a **single-user localhost** app: **one embedded OpenCode server, many
sessions** (not Crux's process-per-session).

## 9. Open decisions (confirmed)

- Shell: **localhost web app** (not Electron).
- Sources: **CSV + live Postgres** in the MVP.
- Control flow: **fully agent-orchestrated** (no deterministic runner).
