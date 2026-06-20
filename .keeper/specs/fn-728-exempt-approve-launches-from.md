## Overview

The fn-725 global `max_concurrent_jobs` budget cap counts a root that is
*finished but awaiting approval* (`blocked:job-pending`) as an occupant
via `isRootOccupant`/`isLiveWorkOccupant`. When enough pending-approval
rows accumulate, `budget = max(0, cap - occupied)` hits zero and the
`budget <= 0` gate skips ALL new launches — including the very `approve`
workers that would drain those pending rows. This is the classic
resource-cap deadlock (Coffman conditions): the drain class needs a
permit that only the parked work can release, but the parked work never
releases until drained. Observed live: paused=0, cap=3, occupied=5 (1
running work + 4 job-pending), budget=0 → only the one in-flight work job
runs and the four approvers never launch; it cannot self-drain.

The fix establishes the invariant: **the budget governs new work entering
the system (`work` + `close`); it never governs the approvals that retire
work — `approve` is exempt at the launch boundary, everywhere.** Exempt at
BOTH launch sites (task-loop and close-row) via a uniform `verb !== "approve"`
guard that skips the budget gate AND the budget decrement. `occupied`
counting is left unchanged, so an in-flight approver still pushes back on
NEW work on later cycles (correct — a running approver is a live worker).
Secondarily, the `keeper autopilot` viewer's prediction/schedule
simulation (`predictNextDispatches`/`predictFullSchedule`, the
`--- predicted ---`/`--- schedule ---` sections) is removed rather than
kept in sync with the new cap semantics — it is the cap-simulating code
that would otherwise diverge from the server-side reconciler.

End state: a pending-approval backlog can no longer starve its own
approvers; the cap means "max concurrent work/close launches" with
approvers additive on top, bounded by the per-root mutex.

## Quick commands

- `bun test test/autopilot-worker.test.ts` — reconcile + cap-exemption tests
- `bun test test/autopilot.test.ts` — viewer/render tests (post prediction removal)
- `keeper autopilot` — eyeball: viewer shows current/stopped/failed/dependencies, no predicted/schedule sections; `· max N` banner still renders

## Acceptance

- [ ] An `approve` launch (task-level or epic close-row) fires even when `budget <= 0`, at both launch sites
- [ ] An `approve` launch never decrements the shared `budget` at either site
- [ ] `work` and `close` launches stay strictly budget-gated; `occupied` summation is unchanged
- [ ] All other suppression arms (paused, inFlight, failedKeys, isOccupyingJob, liveTabKeys) still apply to `approve` launches
- [ ] The viewer's prediction/schedule sections are gone; `current`/`stopped`/`failed`/`dependencies` and the `· max N` banner (`projectMaxConcurrentJobs`) remain
- [ ] Docs (README, CLAUDE.md, config comment) describe the narrowed cap scope and the approve exemption

## Early proof point

Task that proves the approach: `.1` (worker cap exemption). It reproduces
the live deadlock as a fixture (occupied >= cap with a job-pending approve
verdict alongside a budget-starved work verdict) and asserts only the
approve launches. If it fails: the dual-site guard or the second-cycle
occupancy reasoning is wrong — revisit before touching the viewer.

## References

- fn-725 (`.planctl/specs/fn-725-autopilot-max-concurrent-jobs-cap.md`) — the original cap; its "approval-pending starvation is correct" note is superseded by this epic
- `src/readiness.ts:1404` `isLiveWorkOccupant` / `:1440` `isRootOccupant` — the occupancy predicates (left unchanged)
- Overlap context: fn-727 (autopilot window autoclose) and fn-722 (two-tier test gate) both touch `src/autopilot-worker.ts` reconcile body and the autopilot test files — sequence to avoid collisions

## Best practices

- **Exempt the drain class, don't widen the cap:** counting finished-but-waiting rows as occupants is the resource-cap deadlock; the structural fix is exempting the drainer from the permit, not a larger budget [Khuong 2019, work-conserving schedulers]
- **Cap scope narrows, name kept:** `max_concurrent_jobs` now bounds work/close only; total workers can reach `cap + live approvers`. Decision: keep the name, document the carve-out (cf. River `LocalLimit`/`GlobalLimit`, Knative `containerConcurrency`)
- **Per-root mutex is the secondary bound** on approver fan-out (<=1 approver per root per cycle) — the reason no separate approver semaphore is needed

## Docs gaps

- **README.md** (config-key table ~285-316): add `max_concurrent_jobs` noting `approve` is exempt; (autopilot CLI ref ~710-752 + readiness narrative ~1872-1877): drop `--- predicted ---`/`--- schedule ---` descriptions
- **CLAUDE.md** (`## Autopilot` 115-124): add a bullet on the global cap + the approve exemption
- **config.yaml** `max_concurrent_jobs` comment: note approve-verb launches are counted outside the cap
- **fn-725 spec**: low-pri historical addendum that "starvation is correct" was superseded here
