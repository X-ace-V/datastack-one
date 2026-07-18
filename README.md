# DataStack One

**Vercel for internal data platforms.** Connect a data source, say what you want in plain
English, and an agent does the data-engineering work — profiling, SQL, quality checks,
serving — with a human approval gate in front of every write.

This repo is the **local-first MVP**: a localhost web app where you talk to the agent in a
chat session, and it calls real tools against real DuckDB, real Parquet, and a real
read-only Postgres attach. No mocked demo path.

> **Conversational agent.** The first version of this app was a six-step button wizard driven
> by a deterministic runner. The engine was right; the shell was not — DataStack One is a
> conversational, session-based agent, so the wizard pages and the runner were removed and the
> chat shell replaced them. You now open a session, upload a CSV or attach a Postgres, and ask
> in plain English; an embedded [OpenCode](https://opencode.ai) agent plans and calls the data
> tools live, streaming every step into the chat and pausing inline for your approval before
> any write. See [`PRD.md`](./PRD.md) for the contract and [`DEMO.md`](./DEMO.md) for a
> walkthrough.

---

## Quickstart

**Prerequisites:** Node **≥20**. Nothing else — DuckDB is embedded, and the default model
(`opencode/big-pickle`) is free and needs no API key.

```bash
npm install          # installs deps, incl. the `opencode` agent binary
npm run dev          # backend on :3001, web app on :5173
```

Open **<http://localhost:5173>** — a three-pane shell: the **session sidebar** (left), the
**chat stream** (center), and the **data panel** (right). Create a session, upload a CSV, and
ask a question; the agent's reasoning, tool calls, inline approvals, and query results stream
in live. The backend is real too:

```bash
curl localhost:3001/api/health          # {"status":"ok","service":"datastack-one",...}
curl localhost:3001/api/models          # the live model catalog
```

See [`DEMO.md`](./DEMO.md) for the end-to-end walkthrough (upload → ask → build → publish →
serve), including how to attach a live Postgres.

### Scripts

| Script | What it does |
|--------|--------------|
| `npm run dev` | Backend + web together (the normal way to run it). |
| `npm run dev:server` | Fastify + the embedded OpenCode runtime on `:3001`. |
| `npm run dev:web` | Vite dev server on `:5173`, proxying `/api` to `:3001`. |
| `npm test` | The full vitest suite. |
| `npm run typecheck` | `tsc --noEmit` over both the server and web projects. |

---

## What actually runs

The **data tools** are the agent's only way to touch data — a fixed, audited capability set it
calls conversationally. They live in one `@opencode-ai/plugin`
(`server/tools/plugin.ts`) that OpenCode loads; each `execute()` reaches DuckDB over a loopback
route (`/api/internal/tools/*`) so a credential or on-disk path never crosses into the model's
runtime. The agent chooses the *order*; the tool set fixes the *capabilities*. Every tool that
writes or executes is approval-gated.

| Tool | Approval | What it does |
|------|----------|--------------|
| `list_sources` | — | The session's connected sources, by name + schema — never a path or URL. |
| `profile_source` | — | `read_csv_auto` over a source: schema, types, rows, null %, candidate keys, date columns. |
| `run_query` | — | A read-only `SELECT` over DuckDB (+ any attached Postgres); returns rows to the data panel. |
| `attach_source` | **ask** | ATTACH a registered Postgres by **name**, read-only; the backend resolves name→URL — the tool never sees the secret. |
| `land_parquet` | **ask** | `COPY … TO … (FORMAT PARQUET)` into `data/landing/`, partitioned by ingestion date. |
| `load_warehouse` | **ask** | Parquet → `raw.source`, reporting the row count loaded. |
| `run_transform` | **ask** | Executes the reviewed SQL verbatim into `marts.<table>`. |
| `run_dq_check` | — | Runs data-quality checks; a failing run blocks a later publish for the session. |
| `publish_serving` | **ask** | Exports the CSV snapshot and registers the REST endpoint. |

**The approval gate is the point.** Each write pauses the turn with an inline Allow/Deny that
shows the exact SQL/DDL first; nothing writes or attaches without an explicit human decision.
OpenCode does not gate custom plugin tools, so the gate is enforced backend-side: the write's
loopback route opens a pending approval and awaits `POST /api/approvals/:requestID` before it
executes.

**The served endpoints read the published CSV snapshot**, not the live `marts` table, so a
later run whose checks failed cannot leak un-published rows to REST callers.

### Models

Model-agnostic through OpenCode's router. The default is the free **`opencode/big-pickle`**.
Paid models appear only if a provider key (e.g. `ANTHROPIC_API_KEY`) is in the environment at
boot — OpenCode discovers providers from env keys, so a paid model either genuinely exists in
the catalog or is honestly absent.

---

## HTTP API

The full conversational surface: sessions, the chat turn, the SSE event stream, sources,
connections, approvals, the served endpoints, and the model catalog.

| Route | Purpose |
|-------|---------|
| `GET /api/health` | Liveness. |
| `GET /api/models` | Live provider/model catalog (FR13). |
| `POST /api/sessions` · `GET /api/sessions` | Create / list chat sessions (FR1). |
| `GET /api/sessions/:id` | A session with its message history (FR1). |
| `GET /api/sessions/:id/lineage` | A session's audit trail: write tool calls, approvals, DQ results (FR12). |
| `PATCH /api/sessions/:id` · `DELETE /api/sessions/:id` | Rename / delete a session (FR1). |
| `POST /api/sessions/:id/chat` · `POST /api/sessions/:id/cancel` | Send an NL turn / cancel the in-flight turn (FR2). |
| `POST /api/sessions/:id/sources` | Upload a CSV into a session → loaded in DuckDB + registered so the agent tools see it (FR4). |
| `GET /api/events` | SSE chat stream: per-session routing + `?lastSeq` replay (FR3). |
| `POST /api/connections` · `GET /api/connections` | Register / list database connections by name; the URL is entered only here and the list never returns a secret (FR5). |
| `DELETE /api/connections/:name` | Remove a registered connection (FR5). |
| `POST /api/connections/:name/test` | Probe a registered connection read-only; returns `{ok, error}` with the credential scrubbed (FR5). |
| `POST /api/projects` · `GET /api/projects` | Create / list projects. |
| `POST /api/projects/:id/source` · `GET /api/projects/:id/sources` | Upload / list CSV sources (FR4). |
| `POST /api/projects/:id/profile` | Profile a source (FR6). |
| `POST /api/projects/:id/rules` · `GET /api/projects/:id/rules` | Save (file or textarea) / read a rules doc. |
| `GET /api/projects/:id/artifacts` | Latest artifact per kind. |
| `POST /api/approvals/:requestID` | Answer an OpenCode permission request (FR10). |
| `GET /api/projects/:id/served` | Endpoints this project has published. |
| `GET /api/serve/:name` · `GET /api/serve/:name.csv` | The generated endpoint: JSON preview / CSV download (FR11). |
| `POST /api/internal/tools/list_sources` · `POST /api/internal/tools/profile_source` · `POST /api/internal/tools/run_query` | Loopback the agent's read data-tools call; session-scoped, name-only (FR4/FR6/FR7). |
| `POST /api/internal/tools/run_dq_check` | Loopback for the read-only DQ tool; runs the reviewed checks and a failing run blocks a later publish for the session (FR9). |
| `POST /api/internal/tools/land_parquet` · `POST /api/internal/tools/load_warehouse` · `POST /api/internal/tools/run_transform` · `POST /api/internal/tools/publish_serving` | Loopback for the four approval-gated write tools; executed only after inline approval (FR8). |
| `POST /api/internal/tools/attach_source` | Loopback for the ask-gated attach tool; resolves a connection name→URL and ATTACHes it read-only after inline approval — the URL never reaches the model (FR5b). |

The `internal/tools/*` routes are the loopback the in-process OpenCode plugin
(`server/tools/plugin.ts`) calls — the agent's tools run in a separate runtime with no
direct store access, so they reach the store through these. They take a session id and a
source **name** and never a raw path or credential (FR5b). The write routes
(`land_parquet`/`load_warehouse`/`run_transform`/`publish_serving`/`attach_source`) each
pause on an inline human approval before executing, so nothing is written or attached
unapproved (FR8/FR10).

---

## Layout

```
server/
  core/        pure domain logic — no fs, no net, no process (schemas, SQL builders, parsing)
  store/       DuckDB: platform metadata tables, projects, runs, artifacts, lineage, registry
  tools/       the data-engineering tools (profile, land, warehouse, transform, dq, serve)
  opencode/    the embedded agent runtime: client, model catalog, event bridge, permissions
  serving/     the dynamic served-table reader
  app.ts       the Fastify server (routes + status mapping); index.ts wires the real deps
web/src/       React 19 + Vite + Tailwind v4 — the chat shell (sidebar · chat stream · data panel)
fixtures/      synthetic lending CSV + the plain-English rules doc (committed)
tests/         cross-cutting suites
data/          warehouse, landing, uploads, artifacts, serving exports (gitignored, disposable)
```

`server/core` is pure and imported by everything else; nothing in `core` imports back out.
Relative imports in server code end in `.js` (ESM NodeNext) even from `.ts`; `web/` uses its
own tsconfig and extensionless imports.

## Tests

```bash
npm test                 # full suite
npm run typecheck        # both projects
```

**Fixtures are synthetic and load-bearing.** `fixtures/loans_sample.csv` is built so every
rule in `fixtures/rules.txt` is real work: `loan_amount` is thousands-separated *text* so
"convert to numeric" cannot be a no-op, and 24 rows hold 22 customers so "remove duplicate
customers" is genuinely ambiguous. Never point this pipeline at real data — and never through
a free model.

---

## Documents

| Doc | What it is |
|-----|------------|
| [`PRD_DataStack_One.md`](./PRD_DataStack_One.md) | Product vision — north star, personas, long-term scope. |
| [`PRD.md`](./PRD.md) | Engineering build contract — MVP scope, FRs, standards, acceptance. |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | System design — processes, folders, tools, data/approval/event flows. |
| [`AGENTS.md`](./AGENTS.md) | Agent rules + the accumulated lessons of the build. |
| [`DEMO.md`](./DEMO.md) | End-to-end walkthrough + live-Postgres (Neon) setup. |

## Status

**MVP complete.** The conversational shell is live end to end: create a session, upload a CSV,
ask in plain English, and the agent profiles, queries, and — with an inline approval on every
write — builds and publishes a served report, all streamed into the chat. The PRD §5 acceptance
criteria are asserted by `tests/acceptance.test.ts`, which replays a captured free-model
(`opencode/big-pickle`) run against the real DuckDB path. The v1 wizard that proved the engine
was removed; a form was the wrong interface for this product.
