# DataStack One

**Vercel for internal data platforms.** Connect a data source, describe what you want in
plain language, and an agent stands up a real, running, observable data pipeline —
ingestion → landing → warehouse → transform → quality checks → serving — with a human
approval gate in front of every write.

This repo is the **local-first MVP**: a localhost web app that proves one complete data
platform bootstrap flow end to end, on real DuckDB and real Parquet. No mocked demo path.

```
Upload a loan CSV → agent profiles it → agent generates a plan, SQL and DQ checks →
you approve → pipeline runs (Extract → Land → Load → Transform → DQ → Publish) →
you get a branch-level report as a table, a CSV download, and a REST endpoint.
```

---

## Quickstart

**Prerequisites:** Node **≥20**. Nothing else — DuckDB is embedded, and the default model
(`opencode/big-pickle`) is free and needs no API key.

```bash
npm install          # installs deps, incl. the `opencode` agent binary
npm run dev          # backend on :3001, web app on :5173
```

Open **<http://localhost:5173>** and walk the six-step wizard. To drive the fixture demo
end to end in about five minutes, follow **[`DEMO.md`](./DEMO.md)**.

Check the backend alone:

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

The six wizard steps map to six pipeline stages, executed by a **deterministic runner** —
the agent generates the artifacts, then the runner executes them. That split is deliberate:
it keeps a live demo reproducible while the interesting part (planning, SQL, checks) stays
genuinely agentic.

| Stage | Tool | Approval | What it does |
|-------|------|----------|--------------|
| Extract | `profile_source` | — | `read_csv_auto` over the upload: schema, types, rows, null %, candidate keys, date columns. |
| Land | `land_parquet` | **ask** | `COPY … TO … (FORMAT PARQUET)` into `data/landing/`, partitioned by ingestion date. |
| Load | `load_warehouse` | **ask** | Parquet → `raw.source`, reporting the row count loaded. |
| Transform | `run_transform` | **ask** | Executes the reviewed SQL verbatim into `marts.<table>`. |
| DQ | `run_dq_check` | — | Runs the generated checks. **Any failure fails the run, so publish never executes.** |
| Publish | `publish_serving` | **ask** | Exports the CSV snapshot and registers the REST endpoint. |

**The approval gate is the point.** Every write/execute tool pauses the run and shows you
the exact SQL before it runs; approve executes it once, reject aborts the run. Nothing is
approved in bulk and nothing runs unapproved — the acceptance test proves this by reading
the audit trail *before* each approval and asserting the tool has not yet run.

**Data quality blocks publish.** The DQ stage throws on a failed check, so a run with bad
data never reaches Publish and never registers an endpoint. The served endpoints read the
**published CSV snapshot**, not the live `marts` table, so a later DQ-failed run cannot
leak un-published rows to REST callers.

### Models

Model-agnostic through OpenCode's router. The default is the free **`opencode/big-pickle`**,
and the whole flow completes on it. The Plan step's picker has a **Free | Quality** toggle;
the Quality tier lists paid models only if a provider key (e.g. `ANTHROPIC_API_KEY`) is in
the environment at boot — OpenCode discovers providers from env keys, so a paid model either
genuinely exists in the catalog or is honestly absent.

The model only does work in the three generation stages (plan, transform, DQ). The runner
calls no model, so a run's recorded model is *provenance* — which model wrote the artifacts
this run executed.

---

## HTTP API

| Route | Purpose |
|-------|---------|
| `GET /api/health` | Liveness. |
| `GET /api/models` | Live provider/model catalog (FR11). |
| `POST /api/projects` · `GET /api/projects` | Create / list projects (FR1). |
| `POST /api/projects/:id/source` · `GET /api/projects/:id/sources` | Upload / list CSV sources (FR2). |
| `POST /api/projects/:id/profile` | Profile a source (FR2). |
| `POST /api/projects/:id/rules` · `GET /api/projects/:id/rules` | Save (file or textarea) / read the rules doc (FR6). |
| `POST /api/projects/:id/plan` | Generate the architecture plan (FR3). |
| `POST /api/projects/:id/transform` | Generate transform SQL + assumptions/questions (FR6). |
| `POST /api/projects/:id/dq` | Generate the DQ checks (FR7). |
| `GET /api/projects/:id/artifacts` | Latest artifact per kind, for review (FR6/FR7). |
| `POST /api/projects/:id/run` | Start a run — returns `202`, the run outlives the request (FR9). |
| `GET /api/projects/:id/runs` | Run history. |
| `GET /api/runs/:runId` | Run state + **pending** approvals (live-run recovery). |
| `GET /api/runs/:runId/events` | SSE progress stream (FR9). |
| `POST /api/runs/:runId/approvals/:requestID` | Answer a pipeline approval gate (FR8). |
| `GET /api/runs/:runId/lineage` | **Decided** approvals, tool calls, DQ results (FR12). |
| `POST /api/approvals/:requestID` | Answer an OpenCode permission request. |
| `GET /api/projects/:id/served` | Endpoints this project has published. |
| `GET /api/serve/:name` · `GET /api/serve/:name.csv` | The generated endpoint: JSON preview / CSV download (FR10). |

`GET /api/runs/:runId` and `GET /api/runs/:runId/lineage` are **not** the same list:
the former returns pending in-memory gates (so a reloaded UI can recover a live run), the
latter returns the persisted audit of what was decided.

---

## Layout

```
server/
  core/        pure domain logic — no fs, no net, no process (schemas, SQL builders, parsing)
  store/       DuckDB: platform metadata tables, projects, runs, artifacts, lineage, registry
  tools/       the data-engineering tools (profile, land, warehouse, transform, dq, serve)
  pipeline/    the deterministic stage runner, its approval gate, and the generation stages
  opencode/    the embedded agent runtime: client, model catalog, event bridge, permissions
  serving/     the dynamic served-table reader
  app.ts       the Fastify server (routes + status mapping); index.ts wires the real deps
web/src/       React 19 + Vite + Tailwind v4 — the six-step wizard
fixtures/      synthetic lending CSV + the plain-English rules doc (committed)
tests/         cross-cutting suites, incl. the PRD §5 acceptance test
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

The **acceptance test** (`tests/acceptance.test.ts`) drives the real production path on the
committed fixture — real server over a real socket, real DuckDB, real tools, real approval
gate — with one `it` per PRD §5 criterion. The one thing it does not do live is call the
model: the three generation stages replay cassettes recorded from a live `opencode/big-pickle`
run, so the executed SQL is genuinely the free model's while `npm test` never depends on a
model's mood. To run it against the live model and re-record:

```bash
ACCEPTANCE_LIVE_MODEL=1 npx vitest run tests/acceptance.test.ts
```

Re-record whenever a prompt in `server/core/{plan,transform,dq}.ts` changes — a stale
cassette tests a prompt that no longer exists.

**Fixtures are synthetic and load-bearing.** `fixtures/loans_sample.csv` is built so every
rule in `fixtures/rules.txt` is real work: `loan_amount` is thousands-separated *text* so
"convert to numeric" cannot be a no-op, and 24 rows hold 22 customers so "remove duplicate
customers" is genuinely ambiguous. Never point this pipeline at real data — and never
through a free model.

---

## Documents

| Doc | What it is |
|-----|------------|
| [`DEMO.md`](./DEMO.md) | **The scripted demo walkthrough** — the five-minute path on the fixture. |
| [`PRD_DataStack_One.md`](./PRD_DataStack_One.md) | Product vision — north star, personas, long-term scope. |
| [`PRD.md`](./PRD.md) | Engineering build contract — MVP scope, FRs, standards, acceptance. |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | System design — processes, folders, tools, data/approval/event flows. |
| [`AGENTS.md`](./AGENTS.md) | Agent rules + the accumulated lessons of the build. |

## Status

**Working MVP.** All six phases of the backlog are built and the PRD §5 acceptance criteria
pass on the fixture — end to end on the free model, in 87 seconds.

One honest caveat worth knowing before you demo: on this fixture the free model's generated
SQL is *plausible but wrong* (it `TRY_CAST`s the thousands-separated `loan_amount`, which
NULLs every value). The platform behaves correctly — and the model even surfaces the
ambiguity as a clarifying question — which is exactly what the human review gate is for.
[`DEMO.md`](./DEMO.md) makes that a beat in the demo rather than a surprise.
