# DataStack One

**Vercel for internal data platforms.** Connect a data source, describe what you
want in plain language, and an AI agent stands up a real, running, observable data
pipeline — ingestion → landing → warehouse → transforms → quality checks → serving —
with a human approval gate at every critical step.

This repo is the **local-first MVP**: a localhost web app that proves one complete,
working data-platform bootstrap flow end to end.

---

## Document map

Read these in order. Nothing here is built yet — this is the design set to confirm.

| Doc | What it is |
|-----|------------|
| [`PRD_DataStack_One.md`](./PRD_DataStack_One.md) | **Product vision** — the north star, personas, long-term scope. Unchanged. |
| [`PRD.md`](./PRD.md) | **Engineering build contract** — MVP scope, functional requirements, stack, standards, acceptance criteria. The thing the build loop obeys. |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | **How it's built** — system diagram, process layout, folder structure, the OpenCode integration, custom tools, data + approval + event flows. |
| [`TASKS.md`](./TASKS.md) | **Build backlog** — phased, one-task-at-a-time queue for the loop. |

### Build-loop harness (activates after you confirm the docs above)

| File | Role |
|------|------|
| [`LOOP.md`](./LOOP.md) | **Loop operating spec** — modes, Definition of Done, acceptance rubric, commit discipline, stop conditions. Authoritative. |
| [`PROMPT.md`](./PROMPT.md) | The per-iteration checklist each fresh build session follows. |
| [`AGENTS.md`](./AGENTS.md) | Standing agent rules + accumulated lessons (loaded every session; the standard `AGENTS.md` convention). |
| [`PROGRESS.md`](./PROGRESS.md) | Append-only build log. |
| `loop.sh` | Runs N fresh sessions against `PROMPT.md` until all tasks complete. |

---

## The one-paragraph technical summary

A local **Node/TS backend** embeds the **OpenCode** agent runtime and registers a set
of **custom data-engineering tools** (profile, land, load, transform, quality-check,
serve). A **React + Vite + Tailwind v4** UI on `localhost` drives it — subscribing to
OpenCode's live **event stream** for task-level progress and its **permission stream**
for the approval gate. The warehouse is **DuckDB** (embedded, zero-setup). The agent is
driven model-agnostically through OpenCode's router — default is the **free
`opencode/big-pickle`** model for the prototype, with a one-click upgrade to a stronger
paid model for reliability. No customer data, synthetic lending fixtures only.

## Status

📋 **Design phase.** Awaiting confirmation of the docs above before scaffolding begins.
