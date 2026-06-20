## Description

**Size:** M
**Files:** src/readiness.ts, src/autopilot-worker.ts, test/readiness.test.ts, test/autopilot-worker.test.ts, CLAUDE.md

### Approach

Consume task 1's embedded fact as a new occupant verdict that holds the
mutex but never dispatches, with a read-time staleness floor.

1. Add `monitor-running` and `monitor-stale` to the `RunningReason` union
   (`src/readiness.ts:271-272`), mirroring `sub-agent-running` /
   `sub-agent-stale`.
2. Add a pure `anyEmbeddedJobHasLiveMonitor(task.jobs)` helper (mirror
   `anyEmbeddedJobHasRunningSubagent`) reading task 1's embedded fact, and
   an `allLiveMonitorsAreStale` split keyed on a new `MONITOR_STALENESS_SEC`
   lease, anchored on the embedded job's `updated_at`, with `now`
   caller-injected (read-time — NEVER folded; the sanctioned determinism
   exception). Lease/TTL framing: soft TTL (turn-end cadence × ~3-5, NOT
   test-suite duration) → `monitor-stale` (still occupies, visibility);
   a hard ceiling → no longer occupies (release the slot).
3. Add the task-path predicate slotted AFTER the sub-agent predicate (6,
   `:600-634`) and BEFORE the git-6.5 predicate; add the close-row twin
   alongside the close-row sub-agent predicate (`:887-930`).
4. CRITICAL FIX: AND `!anyEmbeddedJobHasLiveMonitor(task.jobs)` into the
   predicate-1 terminal-completed gate (`:556-563`) — the exact gate that
   collapsed `approve::fn-715.2` while the suite was still running.
5. Confirm the new reason is a `running`-tagged verdict so
   `isLiveWorkOccupant` (`:1084-1097`, per-epic) and `isRootOccupant`
   (`:1116-1121`, per-root) occupy with NO change there — a worker-launched
   test suite holds the working tree, so it occupies the root (no
   planner-style exemption).
6. `verbForVerdict` (`src/autopilot-worker.ts:576`) returns `null` for both
   `monitor-running` and `monitor-stale` → occupies but never dispatches;
   pin a null-lock test (fn-700/fn-703 precedent). Confirm the verdict
   flows through `reconcile`'s `isOccupyingJob` path (`:610`).
7. CLAUDE.md: revise the "mutex occupancy definition" bullet to add the new
   verdicts + the staleness analogue, and mention `monitor-running` in the
   `verbForVerdict`-null callout.

### Investigation targets

**Required** (read before coding):
- src/readiness.ts:271-272 (`RunningReason` union), :304 + :276-303 (`SUBAGENT_STALENESS_SEC` + its `now`-injection doc — the template for the lease)
- src/readiness.ts:556-563 (predicate 1 terminal-completed — the gate to fix), :600-634 (predicates 5/6 + `anyEmbeddedJobHasRunningSubagent` / `allRunningSubagentsAreStale` to mirror)
- src/readiness.ts:887-930 (close-row 5/6 twins), :1084-1097 (`isLiveWorkOccupant`), :1116-1121 (`isRootOccupant`)
- src/autopilot-worker.ts:576 (`verbForVerdict`), :610 (`isOccupyingJob`), :313 (`liveTabKeys`)
- test/readiness.test.ts:44-199 (harness; `makeEmbeddedJob` :116-136 — extend default with the task-1 monitor field), :283-360 (fn-671 done+approved templates), :199/:213 (no-now vs now-injected entrypoints)

**Optional** (reference as needed):
- test/autopilot-worker.test.ts (null-dispatch test pattern for blocked/null verdicts)

### Risks

- `ambient` must never occupy: filtered at task 1, but add a readiness test proving an ambient-only job stays dispatchable (defense in depth).
- TTL calibration: anchor on turn-end cadence, not task duration — a too-short TTL false-kills a legitimate long suite; a too-long one wedges the slot (hence the hard ceiling).
- Predicate ranking: after sub-agent (6), before git-6.5 — wrong rank could mask `epic-not-validated` on a stub or `planner-running` during scaffolding; verify against the existing rank comments.
- `updated_at` lease coarseness inherited from task 1 — see task 1 Risks.

### Test notes

Readiness (mirror the fn-671 done+approved templates): a done+approved
task whose embedded work job has `has_live_worker_monitor=true` →
`running:monitor-running` (NOT `completed`) — the direct fn-715.2 repro;
ambient-only embedded fact → not occupying (dispatchable); past soft-TTL →
`monitor-stale` (still occupies); past hard ceiling → released; both
per-epic and per-root occupancy asserted. Autopilot: `verbForVerdict`
returns `null` for both verdicts (null-lock).

## Acceptance

- [ ] `monitor-running` / `monitor-stale` running-verdicts added; a done+approved task with a live worker monitor renders `running:monitor-running`, not `completed` (predicate-1 gate ANDs in the live-monitor check) — reproduces + fixes fn-715.2
- [ ] `ambient`-only monitors never occupy (test pins dispatchability); `monitor`/`bash-bg` occupy both per-epic and per-root
- [ ] Staleness split via `MONITOR_STALENESS_SEC` anchored on embedded `updated_at`, `now`-injected at read-time (never folded); soft-TTL → `monitor-stale` (occupies), hard ceiling → release
- [ ] `verbForVerdict` returns `null` for both verdicts (null-lock test); occupancy never leaks into a dispatch
- [ ] CLAUDE.md mutex-occupancy bullet revised to include the new verdicts + staleness analogue + the `verbForVerdict`-null callout

## Done summary
Added monitor-running/monitor-stale occupant verdicts (predicate 6.6 + close-row twin) consuming task-1's has_live_worker_monitor fact; ANDed embeddedMonitorOccupies into the predicate-1 terminal-completed gate to fix the fn-715.2 premature collapse. Lease/TTL floor: MONITOR_STALENESS_SEC soft->monitor-stale (occupies), MONITOR_RELEASE_SEC hard ceiling->release, now-injected read-time. verbForVerdict returns null for both (running verdicts), pinned by a null-lock test; ambient-only monitors stay dispatchable.
## Evidence
