## Overview

The single-task-per-root mutex (`applySingleTaskPerRootMutex`, src/readiness.ts)
keeps at most one worker per repo root, because autopilot workers share the one
`main` working tree (the branch-guard blocks worktree-add). A launch-window race
lets it leak: a worker's per-root hold is dropped the instant it BINDS, but the
`running` hold only engages at its FIRST ACTIVITY, so a same-root sibling slips
through the gap and two workers race the same working tree. Pinned 2026-06-23 via
event-replay (fn-919.2 + fn-923.1 co-dispatched, ~0.7s gap). Close the gap so the
root is held continuously across the dispatch -> bind -> running handoff.

## Quick commands

- after the fix: two ready same-root tasks never co-dispatch (the mutex holds the
  root continuously across bind -> first-activity)
- `bun run test:full` green (readiness + autopilot + refold-equivalence tiers)

## Acceptance

- [ ] two same-root tasks never dispatch concurrently across the launch -> bind -> running window
- [ ] the per-root mutex (and the per-epic mutex + autopilot cap that share `isRootOccupant`) treat a bound-but-not-yet-working worker as a root occupant
- [ ] no over-hold: a genuinely stopped/dead worker does NOT indefinitely hold the root
- [ ] the never-bound circuit breaker + resume-vs-spawn distinction are unaffected
- [ ] re-fold determinism preserved (test/refold-equivalence.test.ts green)
- [ ] `bun run test:full` green

## Early proof point

Task `.1`'s readiness unit test pinning the handoff window (a bound-but-`stopped`,
`plan_verb`-bearing job occupies its root) in test/readiness.test.ts. If it fails:
the chosen occupancy signal can't disambiguate freshly-bound from stopped-dead;
fall back to the convert-don't-delete fold approach (direction A).

## References

- Pinned diagnosis (event-replay): Dispatched fn-919.2 :15.267 -> bind :18.666
  (pending_dispatches discharged) -> first activity :19.150 (state -> working) ->
  Dispatched fn-923.1 :19.840 (SAME root /Users/mike/code/keeper) = the leak.
- Reverse-dep (advisory, NOT a hard dep): fn-921-harden-keeperd-daemon-stability --
  its "autopilot restored: dispatching keeper-root work cleanly" acceptance depends
  on this reconciler being correct.
- Distinct from fn-921.5 (read-socket connection-cap wedge, already landed) -- that
  was src/server-worker.ts; this is the autopilot reconciler's per-root mutex.
- Aggravator: fn-921.2 (subagent_invocations CPU-peg fanout) stretches reconcile/fold
  lag under load, widening the window.

## Docs gaps

- **README.md** (~2734-2752, ~2183-2186): revise the `dispatch-pending`
  discharge-on-bind / pass-1 occupancy narrative to the post-fix "root held
  continuously across bind -> first-activity" model -- revise in place, don't append.
- **CLAUDE.md** (~403-414): minor precision note on the per-root mutex /
  pending_dispatches occupancy only if the fix names a new occupancy signal.

## Best practices

- **Maintain one unbroken occupancy hold from dispatch-decision through
  first-confirmed-activity; release only on a confirmed terminal event (monotone).** [practice-scout]
- **Treat "pending-dispatch" and "bound-but-not-yet-active" as the SAME occupancy
  class in the readiness gate.** [practice-scout]
- **Prefer a read-time fix (determinism-safe); any fold change must stay pure -- no
  wall-clock, event-id/version fences not time.** [repo-scout + practice-scout]
