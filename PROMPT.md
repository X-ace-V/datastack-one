# DataStack One - loop iteration prompt

You are one iteration of an autonomous build loop. Fresh context; the repo on disk is the
only truth. Read `PRD.md` (the contract) and `LOOP.md` (how this loop operates) first -
`LOOP.md` is authoritative on modes, Definition of Done, acceptance, commits, and stop
conditions. This prompt is the short checklist; obey `LOOP.md` in full.

## Do exactly this, in order

1. Read `PRD.md`, `ARCHITECTURE.md`, `LOOP.md`, `TASKS.md`, `PROGRESS.md`, `AGENTS.md`
   (lessons - never repeat a recorded mistake).
2. Run `git status`. Resolve any leftover uncommitted work before starting (LOOP.md §3).
3. Determine the **mode** (LOOP.md §2): BUILD · REPAIR · REPLAN · BLOCK · DONE. Do exactly
   one mode this iteration.
4. **BUILD/REPAIR:** pick the **topmost unchecked task** in `TASKS.md` - ONE only. Before
   claiming anything is missing, search the codebase; don't assume.
5. Implement it to the **Definition of Done** (LOOP.md §4) - no stubs, no placeholders.
6. **Prove it** (LOOP.md §4–5): write tests that assert the *desired result*; run the
   FULL `npm test` and `npm run typecheck` - both must be green with no weakened gates. If
   the task changes real behavior, run it once and observe the correct output.
7. Only when everything is green: tick the task `[x]`, append one line to `PROGRESS.md`
   (`YYYY-MM-DD Tn.m <task> - result + how acceptance was proven + anything surprising`),
   and commit per LOOP.md §6 (conventional, ≤72-char imperative subject, WHY-body,
   **no trailers, no Co-Authored-By**). Push if a remote exists.
8. If you corrected a wrong assumption, append a one-line lesson to `AGENTS.md`.
9. Stop. One task per iteration, always.

## Blocked / replan (LOOP.md §2, §7)

- Needs a human decision/secret, or the same task failed its gate twice → move it to
  `## Blocked` in `TASKS.md` with a precise reason, commit, stop.
- All tasks `[x]` but PRD §5 acceptance doesn't hold → write the smallest new fix-tasks
  into `TASKS.md`, commit the replan, stop.

## Completion (LOOP.md §7)

All tasks `[x]` AND PRD §5 acceptance all holds → output **exactly** this and nothing
after it: `<promise>ALL TASKS COMPLETE</promise>`
