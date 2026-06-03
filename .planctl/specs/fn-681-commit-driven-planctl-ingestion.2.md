## Description

**Size:** M
**Files:** src/plan-worker.ts, src/rescan.ts, test/plan-worker.test.ts, test/rescan.test.ts

Add the safety nets that guarantee convergence regardless of FSEvents and
regardless of whether git-worker is yet watching a repo: a cheap periodic
`.planctl` reconcile, and a drop-recovery rescan scoped to `.planctl` dirs
instead of the whole root.

### Approach

**Shallow `.planctl` discovery.** Add a helper that, given plan-worker's
configured roots, does a SHALLOW walk (top-level entries under each root,
pruning PRUNE_DIRS) to find `<root>/*/.planctl` directories. Cheap and
independent of the keeper DB — this is what lets it catch a brand-new repo's
first scaffold (the exact case that broke: git-worker only watches a repo's
`.git` after an epic row for it exists in the DB, so the first epic in a new
repo has no commit-trigger).

**Periodic reconcile.** On a low-frequency heartbeat (mirror git-worker's
60s cadence, `git-worker.ts:1596-1605`), run `scanPlanctlDir`
(`plan-worker.ts:1385`) on each discovered `.planctl` dir. The existing
change-gate (`lastEmitted`) makes an in-sync reconcile emit nothing, so the
steady-state cost is a shallow walk + stat/read of the few planctl JSONs.
Keep the reconcile ADDITIVE (re-ingest only, no retraction) to avoid false
tombstones — deletions stay owned by the commit path (task 1) and the
existing boot `sweep`.

**Targeted drop recovery.** Today the per-root `RescanScheduler` callback is
`() => scanRoot(root, scanner)` — a whole-tree walk (`plan-worker.ts:1782`).
Repoint it (on drop) to the `.planctl`-scoped reconcile above so recovery is
O(#projects), not O(`~/code`). Reuse `RescanScheduler` (`rescan.ts:103-158`)
and `isDropError` (`:45-62`) as-is; only the scan callback changes.

### Investigation targets

**Required** (read before coding):
- src/plan-worker.ts:1336-1483 (`scanRoot` + `scanPlanctlDir`), :1385 (`scanPlanctlDir`), :1063-1107 (`sweep` — understand deletion semantics to NOT regress), :1778-1800 (RescanScheduler wiring + the `scanRoot` callback to repoint)
- src/rescan.ts:103-158 (`RescanScheduler`), :45-62 (`isDropError`)
- src/git-worker.ts:1596-1605 (60s heartbeat cadence to mirror), :1505-1528 (`reconcileRoots` shape as a reference)

**Optional** (reference as needed):
- src/plan-worker.ts:240-270 (PRUNE_DIRS for the shallow walk)
- src/daemon.ts:1424-1432 (plan-worker spawn / worker lifecycle for the heartbeat timer)
- test/rescan.test.ts — scheduler test patterns; test/plan-worker.test.ts — scan test patterns

### Risks

- The reconcile must be additive — re-running `scanPlanctlDir` outside the boot `sweep` must not retract live epics. Verify `scanPlanctlDir` alone emits no tombstones (sweep is separate).
- Shallow discovery must prune high-churn dirs and not descend recursively, or it reintroduces cost.
- Heartbeat timer must be cancelled on worker shutdown (mirror RescanScheduler cancel + unsubscribe at :1712-1713) to avoid leaks under `bun test --isolate`.
- Repointing the drop callback must still recover deletions that happened during the drop window — confirm the commit path or a periodic sweep still covers `git rm` during an outage.

### Test notes

`test/plan-worker.test.ts`: a `.planctl` created under a root with NO prior
DB row and NO live FSEvents event is ingested by the periodic reconcile
within one tick (use injectable timers); an in-sync reconcile emits nothing
(change-gate). `test/rescan.test.ts`: on `isDropError`, the scheduled scan is
the `.planctl`-scoped reconcile, not a whole-root walk (assert the callback
target / that only planctl dirs are visited). Use the existing
`SchedulerTimers` injection for deterministic timing.

## Acceptance

- [ ] A shallow discovery finds `<root>/*/.planctl` dirs cheaply (no recursive descent, PRUNE_DIRS pruned)
- [ ] A periodic heartbeat reconciles each discovered `.planctl` via `scanPlanctlDir`; in-sync reconcile emits nothing (change-gate); a new-repo first scaffold converges within one interval without FSEvents or a DB row
- [ ] The on-drop `RescanScheduler` callback is `.planctl`-scoped (O(#projects)), not a whole-root walk
- [ ] Reconcile is additive — no false tombstones; existing boot `sweep` deletion semantics unchanged
- [ ] Heartbeat timer is cancelled on shutdown; `bun test`, typecheck, lint pass

## Done summary
Added periodic .planctl reconcile heartbeat (60s) + repointed on-drop RescanScheduler callback to .planctl-scoped reconcile (O(#projects), not whole-tree). Shallow discoverPlanctlDirs + additive reconcilePlanctlDirs share the change-gated scanPlanctlDir primitive; deletions stay owned by commit channel + boot sweep + live onDelete. Heartbeat timer cancelled in shutdown handler.
## Evidence
