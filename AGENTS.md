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

_(none yet — the first corrected assumption goes here, one line each)_
