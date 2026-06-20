## Overview

The git-worker recovers from a silently-mute FSEvents subscription (the fn-771
re-arm: a genuine heartbeat rescue flags the root; the next reconcile replaces
the @parcel/watcher subscription — bounded, tombstone-free, cache-preserving).
The plan-worker and transcript-worker have no equivalent: a mute subscription
on a .planctl tree or ~/.claude/projects stays mute until a daemon restart, and
both backstops' missed-wake rescues are climbing in the performance babysitter's
telemetry. End state: both workers self-recover a mute subscription within one
heartbeat-to-reconcile cycle, and the babysitter's plan-heartbeat /
transcript-heartbeat missed-wake findings stop recurring.

## Quick commands

- `grep -E 'backstop-missed-wake:(plan|transcript)-heartbeat' ~/.local/state/babysitters/performance/followups/*.md | tail` — the findings that should stop arriving
- `grep -E '\[(plan|transcript)-worker\].*re-arm' ~/.local/state/keeper/server.stderr | tail` — re-arm fire log lines post-land
- `bun run test:full` — mandatory (worker paths are slow-tier)

## Acceptance

- [ ] A mute main-tree subscription in plan-worker is replaced within one heartbeat-to-reconcile cycle, per-root (a rescue never re-arms healthy roots)
- [ ] A mute transcript-worker subscription is replaced by the sequential non-fatal primitive within one 60s heartbeat
- [ ] Re-arm never resets producer state: no phantom re-folds (PlanScanner change-gate / lastEmitted preserved; transcript stream byte offsets preserved)
- [ ] Re-arm decisions are pure exported helpers with unit tests (no live-watcher tests)
- [ ] babysitter backstop-missed-wake:plan-heartbeat and transcript-heartbeat findings stop recurring post-land

## Early proof point

Task that proves the approach: `.1` (plan-worker, the structurally harder
refactor — keying the subscription array + per-root rescue attribution). If the
per-root attribution refactor turns out invasive, fall back to re-arming the
full (small) root set with a strict per-cycle cap and a flap guard, and note
the tradeoff in the Done summary.

## References

- The fn-771 precedent to mirror: src/git-worker.ts:1776-1791 (pendingResubscribe contract), :2256-2284 (tearDownForResubscribe — NOT-a-drop teardown), :2313-2330 (reconcile drain, MAX_SUBSCRIBES_PER_CYCLE=16 at :315), :2503-2559 (heartbeat flagging site)
- Babysitter triage round that routed this: `~/docs/babysitters/performance/rounds/1781203504.md` (missed-wake half of the wake-drop family; the fold-latency half is fn-787-fix-reducer-slow-folds — independent, no dep). After this epic lands, re-stamp the routed backstop-missed-wake ledger rows in `~/docs/babysitters/performance/processed.jsonl` with this epic's slug as `resolved_ref`.
- Sibling-agent boundary (confirmed via chatctl with `tmux-session-id-design`): they do not touch src/plan-worker.ts or src/transcript-worker.ts.
- fn-787 (Fix reducer slow folds): declared independent — disjoint files, no dep.

## Docs gaps

- **README.md** (~lines 268-274, design-principles bullet): "without re-subscribing" must be scoped to the dropped-events re-scan path; name the second recovery path (heartbeat-flagged re-subscribe for mute streams), keep the "data recovery, not process self-heal" boundary sentence
- **README.md** (~lines 2014-2019 plan-worker paragraph + the parallel transcript-worker paragraph): same "without re-subscribing" scoping, parallel structure in both

## Best practices

- **Sequential teardown is the cardinal rule:** `await unsubscribe()` MUST complete before `subscribe()` on the same tree — overlapping live FSEvents streams on one tree is the machine-wide `f2d_register_rpc => (null) (-21)` exhaustion vector [parcel-bundler/watcher #190]
- **Guard in-flight callbacks:** batches can fire after `unsubscribe()` resolves; an active/generation flag prevents a stale callback from touching torn-down state or double-firing the re-arm
- **stat() the root before re-subscribing:** a deleted-and-recreated dir is a new inode FSEvents won't re-attach to; a missing root must defer the re-arm (retry next heartbeat), never error [atom/watcher macOS doc]
- **Full rescan after a fresh subscribe, never back-fill:** APFS coalescing collapses bursts; the post-re-arm rescan reuses the existing scan paths (reconcilePlanctlDirs / scanJobsForTitles)
- **Flap guard:** reset the re-arm flag only after the new subscription survives one full heartbeat interval, so a still-mute replacement doesn't churn streams forever
