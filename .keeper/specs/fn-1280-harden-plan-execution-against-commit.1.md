## Description

**Size:** S
**Files:** src/plan-worker.ts, test/plan-worker.test.ts

### Approach

The boot-reconciliation sweep must retract projection rows only for roots whose boot scan actually COMPLETED. A configured root whose watcher subscribe rejected (or whose scan was otherwise skipped) yields an incomplete census — "not observed this pass", categorically distinct from "definitely absent" — so its epics and tasks must be carried forward untouched, never tombstoned. Today the sweep is called with `data.roots` (all configured roots), and `isWithinRoots` only excludes UNCONFIGURED roots, so a subscribe-failed configured root's epics are in-scope but absent from `seenOnDisk` → false-tombstoned.

Fix: accumulate a `scannedRoots` subset in the enclosing boot scope and pass it to `scanner.sweep(db, scannedRoots)` instead of `data.roots`. A root enters `scannedRoots` ONLY where `scanRoot` actually ran to completion. There are TWO boot loops and both must populate it: the native-watcher loop (push after `scanRoot(root, scanner)` inside the `if (sub !== null)` branch, before `noteBootScanDone`) and the `disableNativeWatcher` poll-tier loop (push inside the try, AFTER `scanRoot` returns — never in the catch, never on the `!existsSync` continue). Keep the barrier COUNT on ALL roots (`rootCount = data.roots.length`; every root still calls `noteBootScanDone` including missing/failed ones) so the sweep still fires — only its retraction SCOPE narrows. `isWithinRoots` and `sweep` already take a roots array; extend the caller, do not fork the scoping. This is a producer-side live path (not a fold), so no re-fold-determinism constraint applies.

### Investigation targets

*Verify before relying — planner-verified at authoring time; the repo moves.*

**Required:**
- src/plan-worker.ts:3843 — the boot barrier (`rootCount` / `noteBootScanDone`) and the `scanner.sweep(db, data.roots)` call (~:3853) whose arg becomes `scannedRoots`.
- src/plan-worker.ts:4159 — the native-watcher boot loop: `subscribeRoot` → `if (sub !== null) scanRoot` → always `noteBootScanDone`. The defect site + native accumulation point.
- src/plan-worker.ts:3865 — the `disableNativeWatcher` poll-tier boot loop (`scanRoot` in a try/catch): the second accumulation point that the in-process test tier exercises.
- src/plan-worker.ts:1927 — `PlanScanner.sweep` + the `isWithinRoots` scope gate (~:1940) and retraction emits (~:1962-1973).
- test/plan-worker.test.ts — the "sweep never retracts an epic whose project_dir is outside the configured roots" test (~:1348) is the exact template to clone; helpers `PlanScanner` / `scanRoot` / `seedFromDb`.

### Risks

- Push to `scannedRoots` ONLY on a clean `scanRoot` return; a push despite a mid-scan throw (poll-tier catch) re-admits a partial-census root and reintroduces the bug for it.
- Keep the barrier count decoupled from the scanned set — if the count follows `scannedRoots.length` the sweep may never fire.
- Behavior change: a genuinely-removed configured root's stale epics now linger (until a live delete path fires) rather than being swept — accepted, since transient-missing and genuinely-removed are indistinguishable at boot and the safe bias is to retain.

### Test notes

Empty `scannedRoots` must retract nothing (`isWithinRoots` over `[]` matches no epic — the fail-closed case). Add a test proving a root whose subscribe returns null does NOT cause its epics to be swept while a sibling root that scanned cleanly still has its genuinely-absent rows retracted. Pure `PlanScanner` unit tier — no daemon/socket/subprocess.

## Acceptance

- [ ] The boot sweep retracts rows only for roots whose boot scan completed; a root whose scan was skipped (subscribe failed) keeps all its epics and tasks.
- [ ] A sibling root that scanned cleanly still has its genuinely-absent rows swept, and an empty scanned set retracts nothing.
- [ ] Both boot tiers (native-watcher and poll) honor this, and the boot sweep still fires (the barrier still completes across all roots).
- [ ] `bun test test/plan-worker.test.ts` is green, including a new test for the skipped-root case.

## Done summary

## Evidence
