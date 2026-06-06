## Overview

A worker that autopilot has LAUNCHED but that has not yet emitted its
`SessionStart` has no `jobs` row yet, so keeper's read-time readiness mutex
(`computeReadiness`, src/readiness.ts) cannot see it as an occupant. Today
the only thing preventing a sibling double-dispatch in that launch→SessionStart
window is the autopilot's serial `confirmRunning` wait (poll for SessionStart
up to a 60s ceiling before the next launch) — a major source of the operator's
30–60s "long time between fires" stalls. The fn-678 `pending_dispatches`
projection DOES durably track that window, but readiness never consumes it
(autopilot reads it only for same-`(verb,id)` dedup).

This epic makes a pending dispatch a REAL mutex occupant: a new
non-dispatchable blocked reason `dispatch-pending` that occupies BOTH the
per-epic and per-root mutex, so a sibling ready task in the same epic OR the
same root is demoted while a dispatch is in flight. This CLOSES the
launch→SessionStart safety gap so that the NEXT epic (step 3, out of scope
here) can remove the serial `confirmRunning` wait without reopening the
fn-627 double-dispatch class. Readiness-only: the Verdict is computed
client-side at read time — NO reducer change, NO schema bump, NO keeper-py
change.

## Quick commands

- `bun test test/readiness.test.ts test/autopilot-worker.test.ts` — the occupancy + non-dispatchable + root-fallback proofs
- `bun run lint && bun run typecheck` — the `formatReasonShort` exhaustive guard FAILS the build if the new `BlockReason` case is missed (forcing function)
- `keeper autopilot` — board shows a `dispatch-pending` sibling demotion live (both paths agree)
- `bun test` — full suite green proves no behavior regression in dispatch gates

## Acceptance

- [ ] New non-dispatchable `BlockReason` `dispatch-pending`; `formatReasonShort` handles it (exhaustive guard satisfied); `verbForVerdict` returns null for it (pinned by a test).
- [ ] `dispatch-pending` is a mutex occupant via the ONE canonical set (`isLiveWorkOccupant` → auto-covers `isRootOccupant`); a sibling ready task in the SAME EPIC and a sibling ready task in the SAME ROOT are both demoted while a pending row exists.
- [ ] The pending row's occupancy clears (sibling dispatchable again) when the row discharges — SessionStart bind / DispatchFailed / DispatchExpired.
- [ ] **Root-fallback (decision b):** a pending row whose `verb::id` matches NO task/epic in the snapshot (launch→materialize lag, or deleted target) still occupies its ROOT via the row's own `dir` column — synthesized outside the per-row walk; must not crash on null `dir` and must not wedge (the row's TTL/discharge still clears it).
- [ ] BOTH readiness paths consume the pending rows and agree: the autopilot worker (`loadReconcileSnapshot` → `reconcile` → `computeReadiness`) AND the board/CLI path (`subscribeReadiness` gains `pending_dispatches` as a 6th subscribed collection + first-paint gate). No divergence between board and autopilot.
- [ ] The existing same-`(verb,id)` `liveTabKeys.has(key)` suppression arms are PRESERVED (they handle same-key re-dispatch; the new occupant handles cross-sibling demotion — orthogonal, both needed).
- [ ] `keeper await` semantics reviewed: `dispatch-pending` on the dispatched row is NOT `workable()` and NOT in `STUCK_REASON_KINDS` (it self-resolves — `waiting`, not stuck); demoted siblings keep their `single-task-per-*` workable status.
- [ ] ZERO reducer/schema/keeper-py change; `pending_dispatches` read-only; full `bun test` green.

## Early proof point

Task that proves the approach: `.1`. The core occupancy test — a pending row
demotes a same-epic AND a same-root ready sibling to `dispatch-pending`
(non-dispatchable), and the demotion lifts when the row discharges. If it
fails: the occupancy injection point (before the mutex passes) or the
canonical-set wiring is wrong — revisit before the consumer-path wiring.

## References

- `src/readiness.ts` — `BlockReason` :226-239 (+JSDoc :162-225); `computeReadiness` :403-546 (`now` is the last positional param; `gitStatusByProjectDir` :432-435 with `=new Map()` default is the precedent for a new optional input); `isLiveWorkOccupant` :1207-1220 (fn-703 git-verdict template), `isRootOccupant` :1239-1244; `applySingleTaskPerEpicMutex` :1246-1285, `applySingleTaskPerRootMutex` :1363-1444; `formatReasonShort` exhaustive guard :1969-2014.
- `src/autopilot-worker.ts` — `dispatchKey`=`verb::id` :281; `verbForVerdict` :601-615 (null for any blocked kind for free); `reconcile` computeReadiness call :685-691; `liveTabKeys` build :1123-1130; same-key suppression arms :717-724, :758.
- `src/readiness-client.ts` — `projectGitStatusByProjectDir` :435 (shared-projection precedent); `subscribeReadiness` collection list :1320-1326; first-paint gate :1328-1336; computeReadiness call :1389-1403; snapshot type :172-176.
- `src/await-conditions.ts` — `workable()` :175-184, `STUCK_REASON_KINDS` :207-214.
- `src/collections.ts` — `pending_dispatches` descriptor :766-767 (confirmed registered subscribable).
- `src/db.ts:1239-1246` — `pending_dispatches` DDL (verb, id, dir, dispatched_at, last_event_id; PK(verb,id)).
- fn-719 occupant integration test template: `test/readiness.test.ts:389-617`.
- epic-scout: zero open epics → no cross-epic deps.

## Architecture

**Occupancy model.** Occupancy stays the ONE canonical set
(`isLiveWorkOccupant`/`isRootOccupant`) — `dispatch-pending` is added there,
never branched at a mutex call site. Two injection mechanisms:
- *Per-row* (the common case): `computeReadiness` matches each pending
  `verb::id` to a task (`work::<task_id>` / `approve::<task_id>`) or close row
  (`close::<epic_id>`) and sets the `dispatch-pending` verdict on THAT row at
  a LATE rank (below real `running` verdicts and below structural-not-ready
  verdicts like `epic-not-materialized`/`epic-not-validated`/`planner-running`,
  above the post-pass mutex demotions — the fn-700 rank-9.5 / fn-719 rank-6.6
  precedent), BEFORE the two mutex post-passes so pass-1 sees it as an occupant.
- *Root-fallback* (decision b): a pending row matching NO snapshot row occupies
  its ROOT via the row's `dir` column — seeded into the per-root mutex outside
  the per-row walk. Covers the launch→materialize lag + deleted-target window.

**Import-layer constraint.** `src/readiness.ts` is the import LEAF
(`readiness-client.ts` and `autopilot-worker.ts` import it, never the reverse).
The new `computeReadiness` input therefore CANNOT use autopilot's
`DispatchKey`/`Verb` types — define a plain shape in `readiness.ts` (e.g.
`PendingDispatch = { verb: string; id: string; dir: string | null }[]`) and
construct the `verb::id` string locally. A shared helper that projects the
`pending_dispatches` wire rows into that plain shape lives at/below the client
layer (mirroring `projectGitStatusByProjectDir`) so BOTH consumers build it
identically.

**Signature.** Append the new param AFTER `now` (low blast radius — the 9+
call sites that rely on defaults stay valid; the simulator/preview paths in
`cli/autopilot.ts` pass an empty set, correctly modelling "no launch-window
occupancy in a what-if").

## Alternatives

- **Per-row-only (no root-fallback)** — REJECTED (human decision b): silent
  zero-occupancy for an unmatched pending row reopens the dispatch hole for
  never-materialized/just-deleted targets — exactly the window step 3 needs
  closed. Root-fallback makes step 3 safe by construction.
- **Collapse the `liveTabKeys` same-key arm into the occupant** — REJECTED:
  the arm suppresses same-`(verb,id)` re-dispatch; the occupant demotes
  cross-siblings. Different jobs; keep both.
- **Fold dispatch-pending into the reducer / a projection verdict** —
  FORBIDDEN: readiness is read-time client-side; folding a client verdict
  breaks re-fold determinism.

## Rollout

Pure read-time gate change; ships behaviorally additive (a new occupant only
*demotes* — never dispatches). `confirmRunning` stays in place this epic, so
the intra-cycle race is still covered (see the loud boundary in `.1`).
Validation: `bun test` green + observe a live `dispatch-pending` demotion on
`keeper autopilot`. Rollback = revert (no migration, nothing persisted).

**SAFETY SEAM (load-bearing):** This epic adds CROSS-cycle occupancy only.
The WITHIN-one-reconcile-cycle race (N siblings ready at once → the 2nd
launch in the same cycle is decided before the 1st's `Dispatched` row folds)
remains covered by the STILL-PRESENT serial `confirmRunning`. Step 3
(removing `confirmRunning`) MUST close the intra-cycle hole (re-load snapshot
between launches, or synchronously seed an in-cycle occupied set as each
`Dispatched` is minted) — otherwise step 2 + step 3 combine into a reopened
fn-627. Do NOT remove `confirmRunning` in this epic.
