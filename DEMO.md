# DataStack One — demo walkthrough

The scripted five-minute path: a loan CSV becomes a running pipeline and a live REST
endpoint, with a human approving every write. Everything below runs on the committed
synthetic fixture and the **free** `opencode/big-pickle` model — no API key needed.

> Timings are from a real run: the three generation stages take most of the clock (~90s
> total on the free model); execution and serving are fast.

---

## 0 · Before you present (2 minutes)

```bash
npm install
rm -rf data/            # optional: clean slate, so the demo shows a first-ever run
npm run dev             # backend :3001, web :5173
curl localhost:3001/api/health    # confirm before you're on a projector
```

Open **<http://localhost:5173>** and have `fixtures/loans_sample.csv` and
`fixtures/rules.txt` ready to drag in. `data/` is disposable and gitignored — deleting it
resets the whole demo.

**The one-line framing:** *"This isn't a SQL generator. It's a pipeline — approval-gated,
quality-checked, and actually serving."* Everything below is in service of that sentence.

---

## 1 · Create the project (~10s)

**Create** step → name it `Lending demo`, domain `lending` → **Create project**.

> It's a real row in the DuckDB `platform` schema — the same engine that will hold the
> warehouse. One engine, zero setup.

## 2 · Connect and profile the source (~15s)

**Connect** step → drag in `fixtures/loans_sample.csv` → **Profile schema**.

**What to point at:** 24 rows, 6 columns, and the profile's honest findings —
`created_at` detected as the date column, and **no candidate primary key**.

> The agent profiled the real file with `read_csv_auto`. Note it found no primary key —
> 24 rows, only 22 distinct customers. That ambiguity comes back in step 4, and it's the
> whole reason a human is in this loop.

Also note `loan_amount` typed **VARCHAR**, not a number: the values are thousands-separated
text (`"12,500.00"`). That is deliberate — it makes the rules doc's "convert to numeric" real
work rather than a no-op.

## 3 · Rules and generation (~90s — the model's part)

**Plan** step. The **ModelPicker** sits at the top: **Free** is selected with
`opencode/big-pickle`. (**Quality (paid)** is disabled unless a provider key like
`ANTHROPIC_API_KEY` was in the environment at boot — that's the one-click escape hatch if a
free model can't hold the format.)

Paste or upload `fixtures/rules.txt` — plain English, no SQL:

```
Remove duplicate customers by customer_id.
Convert loan_amount to numeric.
Create a loan_status column:
- overdue if dpd_days > 0
- active if dpd_days = 0 and balance > 0
- closed if balance = 0
Create daily branch-level summary with total active loans and overdue amount.
```

**Save rules**, then run the three generation stages in order:

1. **Generate architecture plan** → ELT · DuckDB · partitioned by ingestion date · six steps.
2. **Generate transform SQL** → the SQL, plus **Assumptions** and **Clarifying questions**.
3. **Generate DQ checks** → six checks across four types (row count, not-null, schema, freshness).

**This is the beat to slow down on.** Scroll to **Clarifying questions**:

> *"What should happen if loan_amount contains non-numeric values that TRY_CAST converts
> to NULL?"*

The model is telling you, unprompted, that it wasn't sure — and on this fixture it's a real
problem: its own SQL `TRY_CAST`s that thousands-separated text, so every value becomes NULL
and `overdue_amount` comes out **0**. **Do not hide this. It is the demo.** A tool that
silently shipped that number is exactly the tool you don't want; this one shows you the SQL
and asks the question before anything executes.

*(If the free model returns malformed JSON — it happens occasionally — just click the button
again, or flip to the Quality tier if a key is set.)*

## 4 · Review (~20s)

**Review** step: the plan, the SQL, and the checks side by side, read-only. **Approve
artifacts** unlocks **Continue to Run**.

> Nothing has executed yet. Not one byte written. This is a review of generated code, and
> approving artifacts is *not* approving execution — that's still per-write, coming next.

## 5 · Run, approving each write (~30s)

**Run** step → **Start run**. Six stages stream live over SSE:
**Extract → Land → Load → Transform → DQ → Publish**.

Four times, the run **stops** and shows a modal with the exact SQL:

| Gate | What you're approving |
|------|----------------------|
| `land_parquet` | `COPY … TO 'data/landing/…' (FORMAT PARQUET, PARTITION_BY (ingestion_date))` |
| `load_warehouse` | `CREATE OR REPLACE TABLE raw.source AS SELECT * FROM read_parquet(…)` |
| `run_transform` | the **verbatim** SQL you just reviewed |
| `publish_serving` | `COPY (SELECT * FROM "marts"."daily_branch_summary") TO … (FORMAT CSV, HEADER)` |

**Approve** each. On the `run_transform` gate, point out that the SQL in the modal is
character-for-character what you reviewed in step 4 — not a look-alike rebuilt at run time.

> Every write in this pipeline stopped and asked. Reject any one of them and the run
> aborts — nothing partial, nothing unapproved. That's not a setting; there's no path
> around it.

Between Transform and Publish, **DQ** runs the six generated checks. On the fixture they
pass and the run publishes.

## 6 · Serve (~20s)

**Continue to Serve**: the served table preview, a **Download CSV** link, a mini dashboard,
and the generated **REST endpoint**. Hit it from a terminal, live:

```bash
curl localhost:3001/api/serve/daily_branch_summary          # JSON
curl -O localhost:3001/api/serve/daily_branch_summary.csv   # the same bytes as the button
```

> Five minutes ago this was a CSV on a laptop. It's now a partitioned Parquet landing zone,
> a DuckDB warehouse, a quality-checked mart, and an endpoint another service can call.

## 7 · Lineage — the closing beat (~15s)

**View run lineage** (or `GET /api/runs/:runId/lineage`): every step, every tool call with
its exact arguments, **all four approvals with who decided what**, and every DQ check result.

> That's the audit trail. Four write tools, four human approvals, six checks recorded. If
> someone asks *"what actually ran against our data?"* — this is the answer, per run.

---

## The variant worth showing: DQ blocks publish

If you have a spare minute, this is the strongest single demo in the app.

Add a row with an empty `balance` to a copy of the fixture, upload it, and run again with a
`not_null` check on `balance`. The **DQ stage fails**, the run stops, and **Publish never
executes** — no CSV, no endpoint, no registry row. The lineage page shows
*"1 of N checks failed — publish was blocked"*, with Publish still **Pending**.

> Bad data didn't reach the endpoint. Not because someone noticed — because the pipeline
> refused. And because the endpoint serves the *published snapshot* rather than the live
> `marts` table, even a run that transformed successfully but failed DQ can't leak a single
> row to a caller.

---

## Recovery

| If | Then |
|----|------|
| A generation stage returns `422` | The free model emitted malformed JSON. Click again, or switch to the Quality tier if a key is set. |
| `Quality (paid)` is disabled | No provider key was in the environment **at boot**. Set `ANTHROPIC_API_KEY` and restart `npm run dev`. |
| The run seems stuck | It's waiting on an approval. Reload the Run page — pending gates are recovered from `GET /api/runs/:runId`. |
| A served endpoint returns `410` | The registry row outlived its export file (`data/` was deleted). Re-run to republish. |
| You want a clean slate | `rm -rf data/` and restart. The fixture and everything committed are untouched. |

## Talking points, condensed

- **Six visible stages**, streamed live — a pipeline, not an answer.
- **Four writes, four human approvals**, exact SQL shown each time, verbatim from review.
- **Six DQ checks** generated from the schema and executed automatically; failure blocks publish.
- **Queryable and downloadable** — the same bytes over REST and the download button.
- **All on a free model**, with a one-click upgrade path that needs no code change.
- **The model got the arithmetic wrong and the platform was still right** — it showed the
  SQL, surfaced the ambiguity, and asked a human first. That's the product.
