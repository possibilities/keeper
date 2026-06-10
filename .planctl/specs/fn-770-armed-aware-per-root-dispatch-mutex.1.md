## Description

**Size:** M
**Files:** src/readiness.ts, src/autopilot-worker.ts, test/readiness.test.ts, test/autopilot-worker.test.ts, CLAUDE.md, README.md

### Approach

Make pass-2 of the per-root mutex eligible-priority, threaded from the
reconciler; leave pass-1 untouched.

1. **src/readiness.ts** — add a trailing optional `eligibleEpicIds?: Set<string>`
   param to `applySingleTaskPerRootMutex` (AFTER `fallbackRoots`) and to
   `computeReadiness` (AFTER `pendingDispatches`); thread it through the
   mutex call at ~599-605. Keep readiness.ts an IMPORT LEAF — do NOT import
   `computeEligibleEpics`/armed-closure; the caller injects the Set.
2. **Discriminator:** `eligibleEpicIds !== undefined` selects the new
   two-pass; an ABSENT param (`undefined`) selects the legacy single-pass,
   byte-identical to today. An EMPTY set still selects two-pass
   (armed-but-nothing-armed → every task row suppressed). Never branch on
   `.size === 0`.
3. **Pass-2 two-pass (only when `eligibleEpicIds` provided):**
   - **Pass-2a (priority):** walk epics in iteration order. For each
     ELIGIBLE epic (`eligibleEpicIds.has(epic_id)`) process its ready TASK
     rows (first-per-root claims the slot, later ready rows on a claimed
     root → `single-task-per-root`). ALWAYS process the ready CLOSE row
     here regardless of epic eligibility — close is mode-exempt, i.e.
     always-eligible — so a finalizer is never starved by the mutex layer.
   - **Pass-2b (residual):** walk epics again; for INELIGIBLE epics process
     ready TASK rows (claim if the root is still unclaimed, else demote).
     Close rows are already settled in 2a.
   - Pass-1's `occupiedRoots` seed (live workers + `fallbackRoots`) is
     shared by both sub-passes exactly as today.
4. **src/autopilot-worker.ts** — compute the eligible set BEFORE
   `computeReadiness` (currently computed at ~1160-1166, AFTER readiness;
   reorder above the ~1085 call). Guard it: `const eligible = armedMode ?
   computeEligibleEpics(snapshot.armedIds, epicById) : undefined` so yolo
   pays NO BFS (O(1) fast path). Pass `eligible` into `computeReadiness`
   AND reuse the SAME const at the gate (~1188) — one shared value, not two
   computations.
5. **KEEP the armed gate at ~1188.** It is NOT redundant after this fix: a
   pass-2b ineligible task can still win a root that has no eligible
   contender and surface `ready`; the gate is the only thing that stops
   that ineligible winner from launching. Dropping it would let armed mode
   dispatch unarmed epics.
6. **Docs:** reword CLAUDE.md (Autopilot section — the "readiness.ts is
   untouched" sentence) and README.md (fn-751 + readiness-library +
   per-root mutex paragraphs) per the epic Docs-gaps notes. Optionally
   refresh the stale `scripts/autopilot.ts` comment ref near `effectiveRoot`.

### Investigation targets

**Required** (read before coding):
- src/readiness.ts:1441-1550 — `applySingleTaskPerRootMutex`: pass-1 1468-1512 (UNCHANGED), pass-2 1514-1549 (the bug; task arm 1519-1533, close arm 1537-1548)
- src/readiness.ts:412-613 — `computeReadiness` signature + the mutex call at 599-605; note how `now`/`pendingDispatches` were appended
- src/readiness.ts:1556-1571 — `effectiveRoot` (root-key resolver incl the `""` rootless bucket) + the stale comment
- src/autopilot-worker.ts:1085-1096 — `computeReadiness` call site
- src/autopilot-worker.ts:1147-1190 — existing fn-751 armed gate (1188) + eligible compute at 1160-1166 (to reorder)
- src/armed-closure.ts:52-99 — `computeEligibleEpics` (pure, cycle-safe BFS) — reuse, do not duplicate

**Optional** (reference as needed):
- src/autopilot-worker.ts:1876-1904 — `loadReconcileSnapshot` mode/armed read (default mode `'yolo'`)
- test/readiness.test.ts:499-535 — existing cross-epic same-root collision test (template for the new cases)

### Risks

- Touching pass-1 by accident re-opens the fn-721/fn-655/fn-663 narrowings (cross-root phantom-lock, close-row scoping). Pass-1 must stay byte-identical.
- Branching on `.size === 0` instead of `undefined` would make armed-but-nothing-armed silently behave like yolo.
- Recomputing the eligible BFS per-row/per-root regresses O(closure) → O(roots × closure).

### Test notes

FAST tier (test/readiness.test.ts — drives `applySingleTaskPerRootMutex`
directly + via `computeReadiness`):
- (a) deadlock repro: eligible ready beats earlier-sorted ineligible ready on a shared root → eligible `ready`, ineligible `single-task-per-root`
- (b) eligible-vs-eligible → first in iteration order wins, deterministic, loser `single-task-per-root`
- (c) `""` rootless bucket with mixed eligibility → ineligible never wins `""` over an eligible row
- (d) `undefined` param → byte-identical legacy single-pass (yolo regression guard)
- (e) empty-set param → two-pass, every task row suppressed (armed-nothing-armed)
- (f) pass-1 live occupant demotes an eligible ready row (no preemption)
- (g) ineligible `fallbackRoots` entry demotes an eligible sibling (launch-window, bounded by TTL)
- (h) ready close row on a free root wins via pass-2a even when its epic is unarmed (not starved by an eligible task)

SLOW tier (test/autopilot-worker.test.ts): full `reconcile` armed-mode
scenario — two open epics share a root, the earlier-sorted one unarmed →
the armed epic's `work` launches, no double-dispatch; a yolo-mode reconcile
stays unchanged.

Run `bun run test:full` before landing (mandatory — reconciler/readiness path).

## Acceptance

- [ ] `applySingleTaskPerRootMutex` + `computeReadiness` take a trailing optional `eligibleEpicIds?: Set<string>`; absent ⇒ legacy single-pass (existing ~9 callers + simulator unaffected).
- [ ] Two-pass pass-2: eligible task rows (+ all close rows) claim roots first; ineligible task rows only take leftover roots.
- [ ] Reconciler computes the eligible set once, before `computeReadiness`, guarded by `armedMode` (no BFS in yolo), and reuses it at the gate.
- [ ] The armed gate at autopilot-worker.ts:~1188 is retained.
- [ ] Pass-1 unchanged; close rows eligibility-blind (always-eligible).
- [ ] FAST cases (a)-(h) + the SLOW reconcile scenario added and passing.
- [ ] CLAUDE.md + README reworded; no surviving "readiness.ts is untouched by mode" claim.
- [ ] `bun run test:full` green.

## Done summary

## Evidence
