## Overview

keeper's two producer workers (`transcript-worker`, `plan-worker`) treat every
`@parcel/watcher` event as "go look", but their subscribe callbacks handle the
`err` argument by logging-and-returning. macOS FSEvents delivers a *dropped-events*
signal ("...must be re-scanned.") through that same `err` argument under
congestion — and when it does, the lost change is gone for good: there may be no
future event for the missed file. This was observed in production — a live session
rename to a `custom-title` was never folded because the watcher event was dropped
(104 such drops logged on plan-worker, 1 on the transcript watcher), leaving the
job title stuck at the lower-priority `payload` value. fn-564's boot scan only
recovers it on a daemon restart. This epic closes the live-path hole: on the
recoverable drop signal, schedule a bounded, debounced, single-flight RE-SCAN that
reuses each worker's existing change-gated boot-scan primitive (`scanRoot` /
`scanJobsForTitles`), so missed changes are recovered in-process without a restart
and without duplicate synthetic events.

## Quick commands

- `bun test --isolate test/plan-worker.test.ts test/transcript-worker.test.ts` — the drop-recovery unit tests pass (re-scan emits deltas; a second re-scan with no change emits nothing)
- `grep -n "must be re-scanned" src/plan-worker.ts src/transcript-worker.ts` — both callbacks match the drop signal
- manual: with keeperd running, trigger an FSEvents drop (sustained churn under `~/code` / `~/.claude/projects`), rename a live session, confirm `jobs.title_source` flips to `transcript` WITHOUT a daemon bounce

## Acceptance

- [ ] Both subscribe callbacks detect the drop signal by matching the substring `must be re-scanned` on the `err` (covers UserDropped / KernelDropped / too-many variants), not the literal UserDropped string
- [ ] On a matched drop, each worker schedules a debounced, single-flight re-scan that reuses its existing boot-scan primitive (`scanRoot(root, scanner)` per affected root for plan-worker; `scanJobsForTitles(db, stream)` for transcript-worker) — never an unsubscribe+re-subscribe
- [ ] The re-scan is change-gated (reuses `lastEmitted`), so re-running over unchanged files emits zero duplicate synthetic events (re-fold determinism preserved)
- [ ] A non-matching `err` keeps today's swallow-and-log behavior; the recovery path never throws out of the callback and never reaches `fatalExit`
- [ ] The debounce timer is cleared in each worker's shutdown handler before `unsubscribe()`, and the timer callback re-checks `shuttingDown` before scanning
- [ ] CLAUDE.md + README.md document the drop-recovery carve-out to the "no in-process self-heal" / fatalExit contract

## Early proof point

Task that proves the approach: `.1` — the pure-core unit test that calls a
worker's re-scan entry twice (boot + simulated drop-recovery) and asserts the
second emits nothing proves the change-gate keeps recovery idempotent. If it
fails: the re-scan is bypassing `lastEmitted` and would re-emit on every drop —
rework recovery to route through the existing change-gated scan path, not a fresh
emit.

## References

- `src/transcript-worker.ts:645-653` — transcript subscribe-callback `err` swallow (edit site); `scanJobsForTitles` at :530 (re-scan primitive, boot-only today)
- `src/plan-worker.ts:567-575` — plan subscribe-callback `err` swallow (edit site, per-root closure); `scanRoot` at :400 (re-scan primitive, boot-only today)
- Verified against `node_modules/@parcel/watcher/src/macos/FSEventsBackend.cc:82-89` — three drop messages, all carrying "must be re-scanned"; and `Watcher.cc:124-137` — drop arrives via the callback `err` arg and the subscription STAYS ALIVE (only `notifyError` tears down)
- fn-564-config-driven-transcript-root-and — the just-closed epic whose boot scan is the restart-only safety net this epic extends to the live path; its close audit misclassified this exact symptom (finding F4) as test-only flakiness

## Docs gaps

- **CLAUDE.md**: add a drop-recovery carve-out in the `transcript-worker` + `plan-worker` module descriptions; the "No in-process self-heal" DO NOT block; the Worker-contract "No in-process self-heal" line; the Producer-worker archetype (a second post-subscribe behavior beyond boot-scan); and the "Treat a watcher event as 'go look'" carve-out (the drop is a meta-event). Follow the existing `**Carve-out (V3)**` inline pattern.
- **README.md**: qualify the "no in-process self-heal" non-goal bullet and the fourth-worker/producer paragraph's "any worker's error event escalates" statement — the scoped recoverable drop deliberately does NOT escalate to fatalExit.

## Best practices

- **Match `must be re-scanned`, not the literal UserDropped string:** FSEvents emits three drop messages (UserDropped, KernelDropped, too-many) — matching only the first silently keeps dropping the other two. [verified against @parcel/watcher 2.5.6 source]
- **Do NOT unsubscribe+re-subscribe on a drop:** the subscription stays alive (`triggerCallbacks` keeps watching; only `notifyError` tears down). Re-subscribing opens a no-watch gap and, on transcript-worker, re-anchors every tail offset at EOF — guaranteeing you miss the very changes you're recovering. Recovery is "run the boot scan again." [verified]
- **Debounce + single-flight is mandatory, not optional:** drops arrive in bursts; an un-debounced re-scan-per-drop is O(tree) and itself causes more UserDropped — a feedback loop. Use a trailing-edge timer so a burst collapses into one scan after it subsides, plus a single-flight "re-scan-again" bit. [verified semantics + inferred tuning]
- **Schedule off the callback:** slow synchronous work inside the watch callback is itself a cause of UserDropped — never block it. [verified]
