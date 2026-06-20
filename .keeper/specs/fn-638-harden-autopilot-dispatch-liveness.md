## Overview

Autopilot's per-root/per-epic mutex is correct, but the liveness signal it
keys on can lie in both directions, and the dispatch ledger that backstops
it can also lie. This epic closes three failure modes that share that root
frame: (P1) a real running worker is invisible because autopilot spawns
`claude` without `--name`, so the session never links to its task; (P3) a
dead/idle worker stays visible as `working` because a stuck orphan sub-agent
holds the Stop gate until the window is closed; (P2) a dismissed approve
window is treated as handled-for-life because the dispatch ledger keys on
launch, not fulfillment. End state: autopilot-dispatched sessions link to
their tasks, a stuck sub-agent can no longer pin a job `working` forever, a
dismissed approve self-heals, and a pre-spawn gate refuses a second live
session in an occupied root.

See `~/docs/keeper-surface-issues/problem-{1,2,3}.md` for the full
code-grounded investigation.

## Quick commands

- `bun test test/reducer.test.ts test/autopilot.test.ts test/readiness.test.ts` — full unit matrix for the touched surfaces
- `bun test test/reducer.test.ts -t Stop` — bounded Stop-guard fold behavior
- Manual smoke: dispatch a task via autopilot, then confirm `jobs.plan_ref` is populated for the spawned session (linkage restored)

## Acceptance

- [ ] Autopilot passes `--name <verb>::<ref>` on every dispatched `claude` (work uses task id, close/approve use epic id), matching the deriver regex exactly
- [ ] A stuck/orphaned running sub-agent can no longer hold a job at `state='working'` indefinitely — the bounded Stop guard releases it once the newest running sub-agent start is older than `MAX_STOP_YIELD_GAP_SEC` relative to the Stop event
- [ ] The Stop-guard change is a pure function of the event log (no `Date.now()` in the fold) and re-folds byte-identically
- [ ] A dismissed approve window re-dispatches on the next job-pending edge; `work`/`close` retain once-for-life launch suppression
- [ ] A pre-spawn gate refuses to spawn a second live session in an already-occupied root
- [ ] CLAUDE.md + README updated for the new `--name` dispatch channel, the bounded-Stop determinism boundary, and (if shipped) the new board pill

## Early proof point

Task that proves the approach: `.1` (bounded Stop guard). If the pure-fold
timestamp comparison can't release a stuck sub-agent re-fold-safely, fall
back to problem-3's heavier alternative — a producer-minted
`SubagentTimedOut` synthetic event folded deterministically (out of scope
here unless the bounded guard proves too blunt).

## References

- `~/docs/keeper-surface-issues/problem-1.md` — concurrent-dispatch race (P1 + the pass-2/job-pending secondary gap)
- `~/docs/keeper-surface-issues/problem-2.md` — dismissed-approve wedge (launch-vs-fulfillment ledger)
- `~/docs/keeper-surface-issues/problem-3.md` — stuck sub-agent holds the Stop gate (the bounded-guard fix + producer-event alternative)
- `fn-637-project-epic-deps-onto-epic-entities` (LANDS BEFORE this epic; not hard-wired as a dep — only task `.4` has real contention, and a whole-epic dep would needlessly gate tasks `.1`-`.3`). Contention to rebase onto, by file: **src/readiness.ts** — fn-637.1 moves the cross-epic resolver out to a new `src/epic-deps.ts` and switches it to an injected timestamp; fn-637.4 reshapes predicate 9 and DELETES the `completedEpics` param from `computeReadiness`. Task `.4` here rebases onto that (its new `RunningReason` is orthogonal — predicate 5/6 — so it is adjacency/line-drift, not a design conflict) and should follow fn-637.1's injected-`now` pattern for its stale check. **scripts/board.ts** — fn-637.1/.4 rewrite the summary-pill block (778-799) and rebase fn-636's assertions; task `.4`'s colorize/pill work (547-556) is a different region but the same file, so it sequences after both fn-636 and fn-637.4. **src/reducer.ts** — fn-637.3 reworks the EpicSnapshot fold + adds helpers; task `.1`'s Stop fold (3722-3785) is an independent region (standard rebase). **scripts/autopilot.ts** — fn-637.4 only reads reason.kind (~537-551, preserved); tasks `.2`/`.3` touch the disjoint dispatch/ledger region. **CLAUDE.md/README.md** — both epics edit these; different sections, rebase. **Schema: NO collision** — fn-637.2 bumps v32->v33; this epic adds no column (the Stop guard is pure fold logic over the existing `ts`).
- `fn-636-add-board-pill-coverage-for-cross` (overlap, not a dependency; its sole task is already done) — both it and task `.4` touch `scripts/board.ts` `renderEpicBlock`/`colorizePillsInLine`. Not hard-wired; task `.4` carries a sequencing note.
- fn-630 (landed) — the `running` verdict tag + `RunningReason` union already exist; do not re-implement the running split.

## Docs gaps

- **CLAUDE.md** "Name scraping is scoped" paragraph — clarify that autopilot's `--name` is the caller-controlled spawn-name channel (not a hook-side scrape), so a future reader doesn't read it as violating the scrape ban.
- **CLAUDE.md** "Producer-only liveness probing" rule — make the determinism boundary explicit for the time-bounded Stop guard: a fold-time comparison against the event's own `ts` is safe; `Date.now()` inside the fold is banned.
- **CLAUDE.md** event-sourcing invariants fan-out enumeration — name the new bounded-Stop `state` transition if it fans through `syncJobLinksOnJobWrite`. (Note: fn-637.4 also edits this enumeration to add its reverse-dep fan-out — rebase onto that.)
- **README.md** `autopilot.ts` client description (~459-481) — `--name` on dispatch, pre-spawn live-session-in-root gate, fulfillment-keyed approve suppression.
- **README.md** board pill inventory (~376-415) — the new stuck-sub-agent pill (only if task `.4` ships).

## Best practices

- **Bias false-negative-safe in the dispatch gate:** a false "something is running" merely blocks a dispatch; a false "nothing is running" double-spawns workers on one task and can corrupt git history. Fail-closed on stale snapshots.
- **Keep the dispatch ledger append-only:** never mutate/delete a `dispatch.log` line; express a cancel/redispatch as a new entry. Hydration's two-pass design depends on the full history.
- **Time logic in the fold uses event `ts` only:** `stop.ts - subagent_start.ts` against a compile-time constant — never `Date.now()`, never a config/`meta`-row value (both break re-fold determinism).
- **`(verb, id)` is the dispatch dedup key** — never `(verb, id, pid)`; pid is a runtime artifact.
