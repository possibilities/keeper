## Description

**Size:** M
**Files:** src/plan-worker.ts, test/plan-worker.test.ts

### Approach

Lift the fn-737 reflog watch-set WIRING out of the worker `main()` closure
into module-scope pure helpers so it stays covered after the live tests are
deleted in `.2`. This is a behavior-preserving refactor — the existing live
reflog tests (`plan-worker.test.ts:2840`, `:2924`) MUST still pass after
it. Extract:
1. `resolveReflogTarget(repoRoot)` (currently ~`:3045`) — pure `existsSync`
   ladder `.git/logs/HEAD` -> `.git/HEAD` -> `null`. Already pure; just hoist
   + export.
2. `discoverPlanctlRepos(roots)` (currently ~`:3062`) — wraps the
   already-exported `discoverPlanctlDirs(roots)` (`:2722`) + `dirname`.
   Parameterize on `roots` and export (thin FS wrapper).
3. From `reconcileReflogWatches` (`:3079-3180`): extract the PURE set
   arithmetic only — `desiredReflogRepos(pending, discovered): Set<string>`
   (the union) and `reflogWatchDiff(desired, live): { toAdd, toDrop }`.
   LEAVE the `watcher.subscribe()/unsubscribe()` I/O and the mutation of
   `reflogSubs`/`reflogSubscribing` in the closure; it now CALLS the pure
   helpers. The pure helpers must be READ-only (no mutation of the worker's
   live sets) — that's what makes them unit-testable and honest.

Compose the already-exported `discoverPlanctlDirs`, `PlanScanner`,
`repoRootFromPlanctlPath` — do not duplicate readdir/dirname logic.

### Investigation targets

**Required** (read before coding):
- src/plan-worker.ts:3045 — `resolveReflogTarget` closure
- src/plan-worker.ts:3062 — `discoverPlanctlRepos` closure
- src/plan-worker.ts:3079-3180 — `reconcileReflogWatches` (the desired-set diff vs the subscribe I/O)
- src/plan-worker.ts:2722 — `discoverPlanctlDirs` (already exported; compose it)
- src/plan-worker.ts:1172 — `PlanScanner.pendingRepos()`
- test/plan-worker.test.ts:1-12 — the pure "(a)" test style to mirror
- test/plan-worker.test.ts:2840 / :2924 — the live reflog tests this seam replaces (must stay green now; deleted in .2)
- test/helpers/git-repo.ts — tmp-git-repo builder for fixture trees

### Risks

- `reconcileReflogWatches` closes over 5+ mutable locals; keeping mutation
  IN the closure (helpers stay pure) is the whole point — an "impure pure
  function" makes the unit test misleading. No runtime behavior change.

### Test notes

- `resolveReflogTarget`: tmp dir with `.git/logs/HEAD` present -> returns it; only `.git/HEAD` -> returns it; neither -> null.
- `discoverPlanctlRepos`: build a tmp root with a couple `.planctl` trees (via git-repo helper) -> returns the repo roots; no real `~/code` roots touched.
- `desiredReflogRepos`: union of pending + discovered.
- `reflogWatchDiff`: `toAdd = desired - live`, `toDrop = live - desired`; a removed `.planctl` repo lands in `toDrop`.
- Confirm `plan-worker.test.ts:2840/:2924` still pass (no behavior change).

## Acceptance

- [ ] `resolveReflogTarget`, `discoverPlanctlRepos`, `desiredReflogRepos`, `reflogWatchDiff` extracted to module scope + exported; `reconcileReflogWatches` composes them
- [ ] Pure unit tests cover: resolveReflogTarget 3 branches; discoverPlanctlRepos against a tmp root; desiredReflogRepos union; reflogWatchDiff add/drop incl. removed-repo
- [ ] No runtime behavior change — the existing live reflog tests (`:2840`, `:2924`) still pass
- [ ] No Worker / `@parcel/watcher` / real `~/code` access in the new unit tests

## Done summary
Extracted fn-737 reflog watch-set wiring to pure module-scope helpers (resolveReflogTarget, discoverPlanctlRepos, desiredReflogRepos, reflogWatchDiff), all exported; reconcileReflogWatches now composes them with I/O + live-set mutation staying in the closure. Added pure unit tests covering all four; existing live reflog tests still green (no behavior change).
## Evidence
