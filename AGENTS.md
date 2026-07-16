# DataStack One — Agent operating rules & accumulated lessons

Local-first "Vercel for data platforms" MVP, built for a hackathon.
This file is read at the start of **every** build session (the standard `AGENTS.md`
convention). Keep it short — standing rules on top, one-line lessons appended below.

Authoritative references: `PRD.md` (contract) · `ARCHITECTURE.md` (design) ·
`TASKS.md` (queue) · `LOOP.md` (how the loop operates) · `PROGRESS.md` (log).

## Build / run

- `npm test` (vitest, full suite) · `npm run typecheck` (tsc) · `npm run dev` (server + web).
- Backend Fastify on `:3001` embeds the OpenCode server; web (Vite) on `:5173`.
- Secrets in `.env` (gitignored): `ANTHROPIC_API_KEY` and other provider keys — never commit.
- `data/` is gitignored (warehouse.duckdb, landing/, uploads/, artifacts/). `fixtures/`
  IS committed (synthetic data only).

## Hard rules (never violate)

- **Definition of Done and acceptance live in `LOOP.md`. A task is not done until every
  gate there is green.** No stubs, no placeholders, no `TODO`, no "simple for now."
- **Never make a gate pass by weakening it** — no deleting/skipping/`.only`/`.skip`ing
  tests, no lowering assertions, no commenting out checks.
- Commit style per `LOOP.md`: conventional, ≤72-char imperative subject, body says WHY.
  **No trailers. No Co-Authored-By. No AI attribution anywhere.** Developer-authored style.
- TS strict, ESM NodeNext — relative imports end in `.js` even in `.ts`.
- `server/core` is pure (no fs/net/process); routes/tools/opencode import core, never reverse.
- One task per iteration; whole suite + typecheck green before check-off.
- Every write/execute tool (`land_parquet`, `load_warehouse`, `run_transform`,
  `publish_serving`) is permission `ask` — never downgrade one to `allow`.
- Synthetic fixtures only; never pipe real data through a free model.
- Default model is `opencode/big-pickle` (free). Keep everything model-agnostic.

## Lessons learned (append, never repeat)

- `TASKS.md`/`PROGRESS.md`/`LOOP.md`/`loop.sh` are gitignored (internal loop state) — edits to them won't appear in `git status`/`git add`; commits contain code only. That's by design, not a bug.
- The `.js`-extension import rule is server-only (NodeNext). `web/` has its own `web/tsconfig.json` (`moduleResolution: bundler`, `jsx: react-jsx`, DOM lib) and uses **extensionless** relative imports; `npm run typecheck` runs both projects. Web component tests live at `web/**/*.test.tsx`, opt into jsdom via a `// @vitest-environment jsdom` docblock, and rely on `@vitejs/plugin-react` in `vitest.config.ts` for JSX.
- To smoke-run ESM server modules ad hoc, write a temp `.mts` file and `npx tsx path.mts` — `tsx --eval`/`-e` compiles to CJS and rejects top-level `await` ("not supported with cjs output format"). DuckDB values come back with bigint fields (e.g. counts), so JSON.stringify them with a bigint replacer.
- `@opencode-ai/sdk` 1.18.3's typed `Config.permission` only accepts fixed built-in keys (`edit`/`bash`/`webfetch`/`doom_loop`/`external_directory`) — it has NO `"*"` wildcard and NO per-custom-tool keys, so ARCHITECTURE §6's literal `{ "*": "allow", "land_parquet": "ask", … }` does not typecheck. Custom write/execute tools are gated at the permission-event layer (the `permission.asked` event + `client.postSessionIdPermissionsPermissionId` reply endpoint, T1.4), not in static config. `server/opencode/config.ts` exports `ASK_TOOLS` as that gate's source of truth and sets the built-in mutation surfaces to `ask` as defense-in-depth.
- `createOpencode`/`createOpencodeServer` spawn the real `opencode` binary via cross-spawn — it must be on PATH, so `opencode-ai` is a runtime dependency (its bin is symlinked into `node_modules/.bin/opencode`). Booting is offline and needs no provider auth as long as you only hit `config.get()`/`app.agents()` and never prompt a model. The SDK's 5s boot timeout is tight for a cold start; the wrapper defaults to 30s. The client returns `{ data, error }` per call — assert `error` is undefined, then read `data`.
- `client.event.subscribe()` returns `{ stream }` directly (an `AsyncGenerator<Event>` from the SSE core), NOT the `{ data, error }` envelope that `config.providers()`/`session.create()` return — iterate it with `for await`. Pass `{ signal }` to abort the pump on shutdown. Event `sessionID` lives in different places by type: directly on `properties.sessionID`, under `properties.info` for `message.updated`, under `properties.part` for `message.part.updated`. Fastify `app.inject` buffers a long-lived SSE response forever, so test the streaming path over a real socket (`app.listen({port:0})` + `fetch` + read the body stream); use `reply.hijack()` + `reply.raw.writeHead/write` and unsubscribe on `req.raw.on("close")`.
- vitest 2.x peers on vite ^5, so keep root `vite` on ^5 — installing vite@6 makes vitest pull a second nested vite and the two `Plugin` types clash in `vitest.config.ts` typecheck.
