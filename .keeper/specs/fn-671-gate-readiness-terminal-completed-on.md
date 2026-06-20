## Overview

`evaluateTask` predicate 1 (terminal-completed) in `src/readiness.ts`
collapses a task to `{tag:"completed"}` the instant
`worker_phase==="done" && approval==="approved"`, with no worker-liveness
guard. Because predicate 1 ranks above predicate 5 (`job-running`) and 6
(`sub-agent-running`), a task whose planctl `done` + approval landed while
its Claude session is still alive (embedded job still `working`, or a
running sub-agent) reads `completed`. A `completed` verdict occupies no
mutex slot (`isLiveWorkOccupant`/`isRootOccupant` both reject it), so the
autopilot dispatches the next/sibling task into the same repo while the
prior worker is still winding down — the "autopilot started this session
before the worker was completed" incident.

Fix-at-the-source: add a two-clause liveness guard to predicate 1 so a
done+approved task stays `running` (falls through to predicate 5/6, which
occupy the mutex) until its session goes idle — mirroring how predicate 7
(own-approval-pending) is deliberately ordered below 5/6 for exactly this
race. End state: `completed` is a strictly stronger invariant
(done + approved + no live worker + no running sub-agent), and the
per-epic + per-root dispatch mutexes hold until the worker truly exits.

## Quick commands

- `bun test test/readiness.test.ts` — readiness verdict + mutex suite, must stay green
- `cd /Users/mike/code/keeper && bun test` — full suite

## Acceptance

- [ ] Predicate 1 returns `completed` only when `worker_phase==="done" && approval==="approved"` AND the embedded job is not `working` AND no running sub-agent
- [ ] A done+approved task whose session is still live reads `running:*` and occupies BOTH the per-epic and per-root mutex, so a dependent/sibling ready task on the same root is held
- [ ] The clean-collapse path (worker genuinely idle) still reads `completed` and frees the mutex
- [ ] The must-flip precedence test is rewritten, new per-task race tests added, full suite green
- [ ] JSDoc synced at all six sites; close-row fan-in CODE kept as a documented backstop (prose narrowed, not deleted); one CLAUDE.md autopilot-dispatch-gates bullet added

## Early proof point

Task that proves the approach: `<epic>.1`. The regression test
(T1 done+approved+session-still-`working`, T2 depends on T1 → T2 must NOT
be ready) reproduces the exact incident and goes green only when the guard
holds the mutex. If it fails: the fall-through is reaching the wrong
predicate — re-check predicate ordering 1→5→6 and the `subRunningByJobId`
job_id keying.

## References

- Lineage (all done): fn-627 (fix-readiness-mutex-iteration-order), fn-629 (tighten-readiness-mutex-docs-and-test), fn-630 (split-readiness-running-verdict), fn-655 (scope-close-row-per-root-mutex-claim), fn-663 (exempt-planners-from-per-root-mutex)
- Crash backstop: `src/exit-watcher.ts` + reducer `Killed` arm transition a dead worker's embedded job out of `working` (data_version-driven over the jobs projection, `(pid,start_time)` recycle guard, boot `seedKilledSweep`) — so the guard cannot wedge permanently on a main-job crash
- epic-scout: zero inter-epic deps/overlaps; open epics fn-669/fn-670 are disjoint from `src/readiness.ts`

## Docs gaps

- **src/readiness.ts JSDoc**: module-top predicate table (lines 13-14), predicate-1 block comment (494-500), `evaluateCloseRow` JSDoc (698-724) and its predicate-5 comment (766-783) — narrow "close-row fan-in is the sole anti-collapse mechanism" to "residual / normally-unreachable backstop"; `applySingleTaskPerRootMutex` fn-655 JSDoc (1010-1062) — note the per-task claim is now the primary lock path
- **CLAUDE.md (and AGENTS.md symlink)**: add one operational bullet to the "Autopilot dispatch gates" section near "Won't dispatch into a dirty repo"
- **test/readiness.test.ts**: the line-216 narrative comment ("predicate 1 wins over 5") must flip with its assertion

## Best practices

- **Two-axis lifecycle vs liveness:** administrative completion (done+approved) and process termination (session alive) are orthogonal signals that race; the mutex must stay held while `running OR (succeeded AND alive)` — collapsing them is the named anti-pattern this fix removes.
- **Crash-robustness requires an independent backstop:** gating completion on liveness MUST pair with a reaper that can fire the exit signal unilaterally, else a silent crash wedges the slot forever. Keeper's backstop is the producer-side `Killed` event (main job) and the `sub-agent-stale` verdict (orphaned sub-agent stays occupying — accepted correctness-over-throughput trade, no new reaper in this fix).
- **Liveness stays at the producer, never in the predicate:** the guard reads only event-sourced projection state (`task.jobs[].state`, `subRunningByJobId`) plus the injected `now`; no OS probe, no wall-clock — no new non-determinism.
