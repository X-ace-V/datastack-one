# DataStack One — Demo & live-Postgres setup

This walks through wiring a **live Postgres** (Neon) into DataStack One so the agent can join
your CSV upload to real database tables — the PRD §5 criterion *"connect a local Postgres and
query its tables (and join a CSV to a PG table) via NL."*

Everything here uses **synthetic data only** (`fixtures/pg_seed.sql`). Never point the app at a
production database — a registered connection is attached **read-only**, but the credential still
belongs in a throwaway demo project.

---

## 1. Seed a Neon database

1. Create a free project at [neon.tech](https://neon.tech) (any Postgres works; Neon is what the
   MVP is documented against). A default `neondb` database is fine.
2. Open the Neon **SQL Editor** (or connect with `psql`) and run the contents of
   [`fixtures/pg_seed.sql`](./fixtures/pg_seed.sql). It creates two synthetic lending tables:
   - `branches` — one row per branch (`north`/`south`/`east`/`west`) with its `region` and
     `manager`. This is the reference side the CSV lacks.
   - `loans` — a small live loan book, so the attached database has more than one table.

   The seed is written in the SQL subset both Postgres and DuckDB accept, so the project's test
   suite can also run it against an in-memory DuckDB — the fixture stays honest with no live DB.

## 2. Get the connection string — **direct endpoint, `sslmode=require`**

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

## 3. Register it in the app

Start the app (`npm run dev`, backend on **:3001**, web on **:5173**) and open
**Settings → Connections** — the *only* place a database URL is entered. Add the connection by a
short name (a SQL identifier, e.g. `neon`), paste the URL, and **Test** it. The URL is stored
server-side in the gitignored warehouse and is **never** sent back to the browser, the chat, or
the model — the agent only ever sees the connection *name* and the table schema.

Then, in a chat session, ask the agent to attach it (`attach_source`, approval-gated) and query
across it — e.g. *"attach neon and show total balance by region, joining my loans CSV to the
branches table."* The backend resolves the name → URL for a read-only `ATTACH`; the credential
never enters the conversation.

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
