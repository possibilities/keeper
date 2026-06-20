## Overview

Fix an autopilot `armed`-mode deadlock: `applySingleTaskPerRootMutex`
(src/readiness.ts) is armed-blind, so its pass-2 ready-tiebreak awards the
single per-root slot to the FIRST ready row in sort order regardless of
arming. When several open epics share a root and only one is armed, an
earlier-sorted UNARMED epic captures the root slot; reconcile's armed gate
(src/autopilot-worker.ts:1188) then suppresses that epic's `work` launch
because it is not eligible — net deadlock, the armed epic never dispatches.
Observed live: planctl had open fn-13/fn-14/fn-15/fn-16 sharing
`/Users/mike/code/planctl`; only fn-15 was armed; fn-13 (lowest sort_path,
ready, unarmed) held the slot and fn-15 sat at `blocked:single-task-per-root`
with no job ever created.

Invariant to enforce: **unarmed epics can still block via dep wiring, but
they cannot hold a root slot against an armed (eligible) epic on the same
root.** The fix makes pass-2 eligible-priority via a new trailing optional
`eligibleEpicIds?: Set<string>` threaded through `computeReadiness` into the
mutex; pass-1 (live-worker physical occupancy) is untouched. End state:
fn-15 dispatches in armed mode without queue-jump gymnastics.

## Quick commands

- `bun run test:full` — mandatory gate (touches reconciler / readiness / worker paths; the default fast `bun test` does NOT cover autopilot-worker.test.ts)
- `bun test test/readiness.test.ts` — fast-tier pure-function mutex tests (runs in both tiers)
- `keeper autopilot` — banner shows `[playing] · armed · N armed`; armed epic on a shared root should reach a worker

## Acceptance

- [ ] In armed mode, an armed (eligible) epic wins the per-root slot over an earlier-sorted unarmed sibling on the same root, and dispatches.
- [ ] yolo mode is byte-for-byte unchanged (the new param is `undefined` → legacy single-pass).
- [ ] Pass-1 live-worker occupancy is unchanged (no preemption of a live worker, even an unarmed one).
- [ ] Ready close rows are never demoted by an eligible task's claim (mode-exempt at the mutex layer, not just at the reconcile gate).
- [ ] CLAUDE.md + README no longer claim "readiness.ts is untouched by mode".
- [ ] `test:full` green.

## Early proof point

Task that proves the approach: `.1` — the FAST-tier deadlock-repro unit test
(eligible ready beats earlier-sorted ineligible ready on a shared root). If
it fails: the two-pass eligible-priority structure is wrong; revisit the
pass-2a/2b split before wiring the reconciler.

## References

- `src/armed-closure.ts` `computeEligibleEpics` — the armed ∪ transitive-upstream BFS, reused verbatim by the caller; do NOT re-derive in readiness.ts (keep it an import leaf).
- fn-751 (done) — introduced armed mode, the `autopilot_state.mode` column + `armed_epics` presence table (schema v62). This fix extends it; no new schema.
- Trailing-optional-param precedent on these exact functions: `now` (fn-638.4), `pendingDispatches` (fn-721) on `computeReadiness`; `fallbackRoots` (fn-721) on `applySingleTaskPerRootMutex`.
- Stale `scripts/autopilot.ts:206-210` comment refs in `effectiveRoot` JSDoc (src/readiness.ts:1559) point to a deleted file — the real mirror now lives in autopilot-worker.ts.

## Docs gaps

- **CLAUDE.md** (Autopilot section): the sentence "the mode check is a SUPPRESSION ARM inside reconcile ... not a readiness pre-filter — `readiness.ts` is untouched" becomes false — reword. Optionally add armed-eligibility to the "Common gates" list. Preserve the close/completion-reap mode-exempt sentence.
- **README.md** (Architecture): fn-751 narrative + the readiness-library paragraph (computeReadiness now takes `eligibleEpicIds`) + the per-root/dispatch-pending mutex prose. Consolidate, don't append; prune the now-false "readiness untouched by mode" wording.

## Best practices

- **Filter before the tiebreak, not inside a comparator:** eligibility depends on mutable mode/armed state; encoding it in a sort comparator breaks ordering stability. Apply as a two-pass partition (eligible first, then residual). [scheduler/sort-purity literature]
- **Physical occupancy stays unconditional:** never make pass-1 `isRootOccupant` conditional on eligibility — two workers in one repo race git state. Only the discretionary ready-tiebreak becomes eligibility-aware. [priority-inheritance / priority-ceiling]
- **Starvation escape is the mode toggle:** an ineligible row stays blocked until disarm / yolo-flip; the level-triggered reconcile re-runs each cycle and the row dispatches naturally. Do NOT add aging/fairness — these rows are mode-suppressed, not low-priority. [k8s gang-scheduling re-admission]
- **Reuse the per-cycle eligible Set:** compute `computeEligibleEpics` once per reconcile cycle and pass the same Set to both `computeReadiness` and the gate; never recompute the BFS per-root.
