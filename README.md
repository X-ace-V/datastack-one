# DataStack One

**Vercel for internal data platforms.** Connect a data source, say what you want in plain
English, and an agent does the data-engineering work — profiling, SQL, quality checks,
serving — with a human approval gate in front of every write.

This repo is the **local-first MVP**: a localhost web app where you talk to the agent in a
chat session, and it calls real tools against real DuckDB and real Parquet. No mocked demo
path.

> **Being rebuilt.** The first version of this app was a six-step button wizard driven by a
> deterministic runner. The engine was right; the shell was not — DataStack One is meant to be
> a conversational, session-based agent, so the wizard pages and the runner have been removed
> and the chat shell is going in. **The web app is empty right now.** The backend, the data
> tools, and the warehouse all still work and are covered by the suite. See
> [`PRD.md`](./PRD.md) for the contract being built to.

---

## Quickstart

**Prerequisites:** Node **≥20**. Nothing else — DuckDB is embedded, and the default model
(`opencode/big-pickle`) is free and needs no API key.

```bash
npm install          # installs deps, incl. the `opencode` agent binary
npm run dev          # backend on :3001, web app on :5173
```

The web app on **<http://localhost:5173>** currently renders nothing. The backend is real:

```bash
curl localhost:3001/api/health          # {"status":"ok","service":"datastack-one",...}
curl localhost:3001/api/models          # the live model catalog
```

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

The **data tools** are the engine, and they are what the agent will call. Each is a plain
function over DuckDB today; every tool that writes or executes is approval-gated.

| Tool | Approval | What it does |
|------|----------|--------------|
| `profile_source` | — | `read_csv_auto` over an upload: schema, types, rows, null %, candidate keys, date columns. |
| `land_parquet` | **ask** | `COPY … TO … (FORMAT PARQUET)` into `data/landing/`, partitioned by ingestion date. |
| `load_warehouse` | **ask** | Parquet → `raw.source`, reporting the row count loaded. |
| `run_transform` | **ask** | Executes the reviewed SQL verbatim into `marts.<table>`. |
| `run_dq_check` | — | Runs data-quality checks; a failure is what blocks a publish. |
| `publish_serving` | **ask** | Exports the CSV snapshot and registers the REST endpoint. |

**The approval gate is the point.** Nothing that writes runs without an explicit human
decision, and the approval shows the exact SQL first.

**The served endpoints read the published CSV snapshot**, not the live `marts` table, so a
later run whose checks failed cannot leak un-published rows to REST callers.

### Models

Model-agnostic through OpenCode's router. The default is the free **`opencode/big-pickle`**.
Paid models appear only if a provider key (e.g. `ANTHROPIC_API_KEY`) is in the environment at
boot — OpenCode discovers providers from env keys, so a paid model either genuinely exists in
the catalog or is honestly absent.

---

## HTTP API

The wizard-era surface plus the v2 session routes. The chat-turn and event-stream routes the
conversational shell also needs are not built yet.

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

The `internal/tools/*` routes are the loopback the in-process OpenCode plugin
(`server/tools/plugin.ts`) calls — the agent's tools run in a separate runtime with no
direct store access, so they reach the store through these. They take a session id and a
source **name** and never a raw path or credential (FR5b). The write routes
(`land_parquet`/`load_warehouse`/`run_transform`/`publish_serving`) are reached only after
the plugin has paused the turn for an inline human approval (`context.ask`), so nothing is
written unapproved (FR8/FR10).

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
web/src/       React 19 + Vite + Tailwind v4 — the chat shell (being built)
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

## Status

**Mid-rebuild.** The v1 wizard shipped, worked, and proved the engine end to end on the free
model — then it was removed, because a form is the wrong interface for this product. What
stands today is the backend engine and its tests; the conversational shell is next.
