# DataStack One — Engineering PRD (MVP Build Contract)

Last updated: 2026-07-16
Status: **proposed — awaiting confirmation**

This is the **contract** the build obeys. The product vision lives in
[`PRD_DataStack_One.md`](./PRD_DataStack_One.md); the technical design in
[`ARCHITECTURE.md`](./ARCHITECTURE.md). This document is the buildable, testable
subset — scope, functional requirements, standards, acceptance, and stop conditions.

---

## 1. Goal

Ship one **complete, working, local data-platform bootstrap flow**:

> Upload a loan CSV → agent profiles it → agent generates a plan, SQL, DQ checks and a
> serving spec → human approves → pipeline runs (Extract → Land → Load → Transform → DQ →
> Publish) → user views/downloads a branch-level daily report and hits a generated API.

"Production enough": real execution, real DuckDB, real Parquet, real approval gating — the
smallest *honest* version of the north star, not a mocked demo.

---

## 2. In scope (MVP)

- **Source:** CSV upload only.
- **Landing:** local Parquet in `data/landing/`, partitioned by ingestion date.
- **Warehouse:** DuckDB (`raw` → `staging` → `marts` schemas).
- **Transformation:** plain-English rules doc → reviewable SQL.
- **Data quality:** ≥3 auto-generated checks; failure blocks publish.
- **Serving:** table preview + CSV download + generated REST endpoint + mini dashboard.
- **Approval gate:** 100% human approval before any write/execute tool runs.
- **Agent runtime:** OpenCode, driven model-agnostically; default free `opencode/big-pickle`.
- **UI:** localhost React + Vite + Tailwind v4, 6-step wizard.

## 3. Out of scope (MVP non-goals)

Mock API / Postgres source connectors · MinIO / real S3 · Postgres / Snowflake / Spark
engines · scheduling · auth / multi-user · enterprise RBAC · CDC / streaming · cost
estimation · real customer data (synthetic fixtures **only**) · automated execution of
unreviewed code.

---

## 4. Functional requirements

Each FR is independently demoable and testable.

- **FR1 — Projects.** Create/list projects with name, business domain, expected volume,
  warehouse (`duckdb`), serving style. Persisted in DuckDB `platform` schema.
- **FR2 — Source connect + profile.** Upload a CSV; agent runs `profile_source` and
  returns schema, column types, row count, null %, candidate primary keys, and date
  columns. Rendered as a table.
- **FR3 — Architecture plan.** Agent produces a structured plan (execution pattern = ELT,
  warehouse = DuckDB, partitioning = ingest date, step list). Human-readable, reviewable.
- **FR4 — Landing.** `land_parquet` writes raw data to `data/landing/` as Parquet
  partitioned by ingestion date.
- **FR5 — Warehouse load.** `load_warehouse` loads Parquet into a DuckDB `raw`/`staging`
  table; records row count loaded.
- **FR6 — Transformation.** Agent reads a plain-English rules doc (`read_rules`) and
  generates SQL (`write_artifact`), surfacing assumptions and any clarifying questions.
  SQL is reviewable before it runs; execution via `run_transform`.
- **FR7 — Data quality.** Agent generates ≥3 checks (row count > 0, null check on key
  columns, schema/type check, freshness). `run_dq_check` runs them; **any failure blocks
  publish** and is shown in the UI.
- **FR8 — Approval gate.** `land_parquet`, `load_warehouse`, `run_transform`,
  `publish_serving` are permission `ask`. The UI shows the exact SQL/DDL and the run
  cannot proceed past a step without an explicit approve. Reject aborts the step.
- **FR9 — Run + progress.** A run executes the 6 stages, streaming per-stage status
  (`pending → running → success/failed`) to the UI over SSE, plus the agent's reasoning.
- **FR10 — Serving.** On success: table preview, CSV download, a generated REST endpoint
  (`GET /api/serve/:name`), and a simple dashboard view of the final report.
- **FR11 — Model routing.** Default `opencode/big-pickle`. `GET /api/models` lists live
  providers/models from `config.providers()`. A UI toggle selects any `provider/model`;
  paid providers authenticate from env keys.
- **FR12 — Lineage / observability.** Each run records its steps, tool calls, approvals,
  and DQ results; viewable per run.

---

## 5. Acceptance criteria (from product PRD §14)

The MVP is "done" when **all** hold on the synthetic fixture:

- [ ] Time from CSV upload to served output is **under 5 minutes**.
- [ ] **100%** of executions required a human approval first (no write/execute ran unapproved).
- [ ] The run shows **≥5 visible pipeline tasks**.
- [ ] **≥3 data-quality checks** were generated and executed automatically.
- [ ] Final output is **queryable (REST) and downloadable (CSV)**.
- [ ] The whole flow runs on **`opencode/big-pickle` (free)** at least once end to end
      (upgrading to a stronger paid model is allowed if the free model cannot complete tool orchestration —
      record that outcome in `PROGRESS.md`).

---

## 6. Engineering standards

- **TypeScript** strict, **ESM NodeNext** — relative imports end in `.js` even in `.ts`.
- **`server/core` is pure** (no fs/net/process); `routes`/`tools`/`opencode` import core,
  never the reverse.
- **No stubs, no placeholders, no "simple for now."** A task ships fully or moves to Blocked.
- **Validation:** zod on every tool arg and API body.
- **Fixtures are synthetic** lending data — never real/confidential data, and never pipe
  real data through a free model.
- **Gate:** `npm test` (vitest) and `npm run typecheck` (tsc) both pass before any task is
  checked off.
- **Commits:** conventional, ≤72-char imperative subject, short why-body only if needed.
  **No trailers, no Co-Authored-By.** One logical change per commit.

---

## 7. Risks & mitigations

| Risk | Mitigation |
|------|-----------|
| Free model too weak for multi-step tool use / json_schema | Model-agnostic from day one; one-click toggle to a stronger paid model via OpenCode's router; record which model completed the demo. |
| Agent non-determinism breaks the live demo | Scripted pipeline: one constrained prompt per stage with a fixed schema and tool subset — agentic within a stage, deterministic across stages. |
| "Looks like another SQL generator" | Emphasize orchestration, the approval gate, DQ blocking, run progress, and the served endpoint — an actual pipeline, not an answer. |
| Unsafe code execution | Every write/execute tool is permission `ask`; exact SQL shown before it runs; DQ failure blocks publish. |
| Scope creep | CSV-only, DuckDB-only, one rules format, one served artifact. Everything else is a deferred slot behind a tool interface. |
| Free-model data retention | Synthetic fixtures only; hard rule against real data on free models. |

---

## 8. Stop / block conditions (for the build loop)

- A task needs something only the human (parker) can provide (a key, a decision) → move it
  to `## Blocked` in `TASKS.md` with what's needed, commit, stop.
- A task fails its gate two iterations running (per `PROGRESS.md`) → move to `## Blocked`
  with a diagnosis instead of a third attempt.
- All tasks checked **and** §5 acceptance holds → the loop emits its completion promise.

---

## 9. Open decisions to confirm before build

1. **UI stepper vs React Flow** for the DAG view — start with a simple stepper, add React
   Flow later? (Recommended: stepper first.)
2. **Metadata store** — DuckDB `platform` schema (one engine) vs a separate SQLite?
   (Recommended: DuckDB `platform` schema.)
3. **Rules doc input** — file upload vs a textarea in the UI? (Recommended: both; textarea
   is faster to demo.)
4. **Should the build loop run now**, or do you want to scaffold Phase 0 by hand first?
