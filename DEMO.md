# DataStack One — Demo walkthrough

This is the end-to-end demo: open a chat session, upload a CSV, ask questions in plain English,
and have the agent build and publish a served report — pausing inline for your approval on every
write. Part 2 adds a **live Postgres** (Neon) so the agent can join your upload to real database
tables.

Everything here uses **synthetic data only** (`fixtures/loans_sample.csv`, `fixtures/rules.txt`,
`fixtures/pg_seed.sql`). Never point the app at production data, and never through a free model —
a registered connection is attached **read-only**, but the credential still belongs to a
throwaway demo project. See [`AGENTS.md`](./AGENTS.md) for why the fixture's shape is
load-bearing.

---

## 0. Start the app

**Prerequisites:** Node **≥20**. The default model (`opencode/big-pickle`) is free and needs no
API key.

```bash
npm install          # installs deps, incl. the `opencode` agent binary
npm run dev          # backend on :3001, web app on :5173
```

Open **<http://localhost:5173>**. The screen is three panes: the **session sidebar** (left), the
**chat stream** (center), and the **data panel** (right). The agent's reasoning, tool calls,
inline approvals, and query results all stream into these live over SSE.

---

## Part 1 — CSV → ask → build → publish → serve

This is the PRD §5 acceptance path, driven entirely by conversation.

### 1. Create a session and upload the CSV

- In the sidebar, click **New session**. Each session is its own OpenCode session with its own
  history; you can run several and switch between them.
- Upload [`fixtures/loans_sample.csv`](./fixtures/loans_sample.csv) into the session (the CSV
  control in the data panel). It is registered as a source and loaded into DuckDB — the agent now
  sees it by name via `list_sources`, with no path or credential ever reaching the model.

### 2. Ask a question in plain English

Type an ordinary question, for example:

> *profile this, then show total balance by branch*

The agent calls `profile_source` and `run_query` (both read-only, no approval needed) and the
result table lands in the **data panel**. Ad-hoc querying is first-class — you don't have to build
a pipeline to interrogate the data.

### 3. Build and publish a daily branch report

Now ask it to build something, for example:

> *clean it per the rules and publish a daily branch summary as an API*

The agent profiles, writes the transform SQL, and calls the write tools. **Each write pauses the
turn with an inline Allow/Deny that shows the exact SQL/DDL** — `land_parquet`, `load_warehouse`,
`run_transform`, then `publish_serving`. Review each, then approve. Nothing is written until you
do: the approval posts to `POST /api/approvals/:requestID`, and the backend holds the tool until
it hears back. A `run_dq_check` that fails will block the publish until the data is fixed.

The `fixtures/rules.txt` doc is deliberately real work (e.g. `loan_amount` is thousands-separated
text so "convert to numeric" is not a no-op) — the human SQL review at each gate is where you'd
catch a model that gets the arithmetic wrong. A green run proves the **platform** works, not that
the report is arithmetically correct.

### 4. Read the served endpoint

Once `publish_serving` is approved, the endpoint shows in the data panel. It reads the CSV
snapshot that passed DQ and that you approved — not the live `marts` table — so a later failed run
can't leak un-published rows:

```bash
curl localhost:3001/api/serve/daily_branch_summary        # JSON preview
curl localhost:3001/api/serve/daily_branch_summary.csv    # CSV download
```

(Use whatever name the agent published; the served name is the endpoint URL.)

### 5. Reopen the session

Reload the page or restart the server and reselect the session in the sidebar — its message and
tool-block history reconstruct from the DuckDB `platform` schema. The per-session audit trail
(write tool calls, approvals, DQ results) is available at `GET /api/sessions/:id/lineage`; the
"approved before executed" invariant reads straight off its `seq` order.

---

## Part 2 — attach a live Postgres (Neon)

This satisfies the PRD §5 criterion *"connect a local Postgres and query its tables (and join a
CSV to a PG table) via NL."*

### 1. Seed a Neon database

1. Create a free project at [neon.tech](https://neon.tech) (any Postgres works; Neon is what the
   MVP is documented against). A default `neondb` database is fine.
2. Open the Neon **SQL Editor** (or connect with `psql`) and run the contents of
   [`fixtures/pg_seed.sql`](./fixtures/pg_seed.sql). It creates two synthetic lending tables:
   - `branches` — one row per branch (`north`/`south`/`east`/`west`) with its `region` and
     `manager`. This is the reference side the CSV lacks.
   - `loans` — a small live loan book, so the attached database has more than one table.

   The seed is written in the SQL subset both Postgres and DuckDB accept, so the project's test
   suite can also run it against an in-memory DuckDB — the fixture stays honest with no live DB.

### 2. Get the connection string — **direct endpoint, `sslmode=require`**

In the Neon dashboard, copy the connection string, then make two adjustments that DuckDB's
Postgres driver needs:

- **Use the direct (non-pooled) endpoint.** Neon's default string points at the PgBouncer pooler
  (host contains `-pooler`). DuckDB's `postgres` extension opens its own session-level connection
  and does not work through the transaction pooler — **delete the `-pooler` suffix** from the host
  so you get the direct endpoint.
- **Keep `sslmode=require`.** Neon only accepts TLS connections.

The result looks like:

```
postgresql://<user>:<password>@ep-xxx-xxx.<region>.aws.neon.tech/neondb?sslmode=require
```

(direct host — note: no `-pooler`).

### 3. Register it in the app

In the running app, open **Settings → Connections** — the *only* place a database URL is entered.
Add the connection by a short name (a SQL identifier, e.g. `neon`), paste the URL, and **Test** it.
The URL is stored server-side in the gitignored warehouse and is **never** sent back to the
browser, the chat, or the model — the agent only ever sees the connection *name* and the table
schema.

Then, in a chat session, ask the agent to attach it and query across it — e.g.

> *attach neon and show total balance by region, joining my loans CSV to the branches table*

`attach_source` is approval-gated (it shows `{connection, type}`, never the URL); approve it and
the backend resolves the name → URL for a read-only `ATTACH`. The credential never enters the
conversation, and `run_query` then spans the CSV and the live PG tables together.

Under the hood the REST surface backing the panel is `POST /api/connections` (add),
`GET /api/connections` (names + types, never secrets), `POST /api/connections/:name/test`, and
`DELETE /api/connections/:name`.

---

## Running the live tests against your Neon

The Postgres-dependent tests **skip cleanly** when no database is configured, so `npm test` is
green without a Neon. To exercise the real attach + join path, point `TEST_PG_URL` at a Neon
seeded with `fixtures/pg_seed.sql` (the same direct-endpoint, `sslmode=require` URL as above):

```bash
TEST_PG_URL='postgresql://<user>:<password>@ep-xxx.<region>.aws.neon.tech/neondb?sslmode=require' \
  npm test
```

With it set, three gated cases run instead of skipping: the connection prober
(`server/connections/postgres.test.ts`), the read-only attach + schema introspection
(`server/connections/attach.test.ts`), and the end-to-end CSV↔Postgres join through `run_query`
(`tests/pg-fixture.test.ts`). The last asserts the CSV's loans grouped by the region the live
`branches` table supplies — the FR5b acceptance path, proven against real Postgres.
