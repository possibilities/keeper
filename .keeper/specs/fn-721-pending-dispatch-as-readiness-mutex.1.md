## Description

**Size:** M
**Files:** src/readiness.ts, src/autopilot-worker.ts, src/readiness-client.ts, src/await-conditions.ts, test/readiness.test.ts, test/autopilot-worker.test.ts, test/await-conditions.test.ts

The cohesive, compile-coupled core: add the `dispatch-pending` occupant and
thread the `pending_dispatches` rows into BOTH readiness paths. Docs are
task .2.

### Approach

Add `dispatch-pending` to `BlockReason` (+JSDoc) and `formatReasonShort`
(the `_exhaustive: never` guard forces this). Add it to `isLiveWorkOccupant`
(the fn-703 git-verdict template) — `isRootOccupant` auto-covers via
delegation. Define a plain `PendingDispatch = {verb,id,dir}[]` type in
`readiness.ts` (NOT autopilot's `DispatchKey` — import-leaf constraint) and
append a `pendingDispatches` param to `computeReadiness` AFTER `now`
(default `[]`). Per-row: match `work::<task_id>`/`approve::<task_id>` in
`evaluateTask` and `close::<epic_id>` in `evaluateCloseRow`, setting the
verdict at a LATE rank before the mutex passes. Root-fallback (decision b):
pending rows matching no row occupy their `dir` root, seeded into
`applySingleTaskPerRootMutex`. Factor a shared `pending_dispatches → PendingDispatch[]`
projection helper (mirror `projectGitStatusByProjectDir`) imported by both
consumers. Thread it through autopilot `reconcile` (:685-691, data already
in the snapshot at :1123-1130) AND `subscribeReadiness` (add the 6th
collection :1320-1326, first-paint gate :1328-1336, computeReadiness call
:1389-1403, snapshot type :172-176). Review `await-conditions` `workable()`
/ `STUCK_REASON_KINDS` (dispatch-pending = waiting, not workable, not stuck).
Keep the same-key `liveTabKeys` arms untouched.

### Investigation targets

**Required** (read before coding):
- src/readiness.ts:226-239 (BlockReason), :1969-2014 (formatReasonShort guard), :1207-1244 (isLiveWorkOccupant/isRootOccupant — fn-703 template), :403-546 (computeReadiness; :432-435 gitStatus optional-input precedent), :1246-1285 + :1363-1444 (mutex passes — injection point), evaluateTask/evaluateCloseRow.
- src/readiness.ts fn-719 occupant + fn-700 epic-no-tasks for the rank/late-placement precedent.
- src/autopilot-worker.ts:281 (dispatchKey), :601-615 (verbForVerdict free-null), :685-691 (computeReadiness call), :1123-1130 (liveTabKeys build), :717-724/:758 (keep same-key arms).
- src/readiness-client.ts:435 (projectGitStatusByProjectDir shared-projection template), :172-176/:1320-1336/:1389-1403 (subscribe wiring + first-paint gate).
- src/await-conditions.ts:175-184 (workable), :207-214 (STUCK_REASON_KINDS).
- src/collections.ts:766-767 (pending_dispatches registered); src/db.ts:1239-1246 (row shape).

**Optional** (reference as needed):
- test/readiness.test.ts:195-219 (run/runWithNow harness — plumb new param), :2451-2711 (standalone mutex tests), :389-617 (fn-719 occupant integration template); test/autopilot-worker.test.ts:124-133 (makeSnapshot), :305/:344 (verbForVerdict-null pins).

### Risks

- Import cycle: readiness.ts MUST NOT import from autopilot-worker.ts — use the plain local type. Verify `bun run typecheck` has no cycle.
- Rank: too early masks a truer verdict (fn-700 anti-pattern); too late never fires. Pin with tests that a real `running`/`epic-not-materialized` still wins.
- Two paths diverging: the shared projection helper must be the SOLE builder; both autopilot and subscribeReadiness use it.
- Root-fallback on null `dir`: must not crash; a null-dir unmatched row contributes no root occupant (degrade safely).
- First-paint gate: an empty `pending_dispatches` must still emit `rows:[]` so all 5 CLIs clear first-paint (dead_letters precedent).

### Test notes

Occupancy: same-epic + same-root sibling demoted to dispatch-pending; clears
on discharge. Root-fallback: unmatched pending row (no task/epic) occupies
its dir root; null-dir degrades. verbForVerdict→null pinned. Both paths:
assert autopilot reconcile and subscribeReadiness compute identical verdicts
for the same pending set. await: dispatch-pending not workable, not stuck.
Negative control: a dep-on-task does NOT claim (occupant-only).

## Acceptance

- [ ] `dispatch-pending` added to `BlockReason` + `formatReasonShort`; `verbForVerdict` null pinned by a test.
- [ ] Occupies per-epic AND per-root via the canonical set; same-epic + same-root siblings demoted while a pending row exists; lifts on discharge.
- [ ] Root-fallback: unmatched pending row occupies its `dir` root; null `dir` degrades without crash.
- [ ] Threaded into BOTH paths via one shared projection helper; autopilot + subscribeReadiness agree (test asserts parity); 6th collection + first-paint gate wired.
- [ ] same-key `liveTabKeys` arms preserved; await `workable()`/`STUCK_REASON_KINDS` reviewed.
- [ ] No reducer/schema/keeper-py change; no import cycle; `bun run lint` + `typecheck` + `bun test` green.

## Done summary
Added the dispatch-pending BlockReason as a per-epic + per-root mutex occupant via isLiveWorkOccupant (auto-covering isRootOccupant), with per-row matching (work::/approve:: tasks, close:: epics) at a late rank plus a dir-column root-fallback for unmatched pending rows. Threaded pending_dispatches through both readiness paths via a shared projectPendingDispatches helper (6th subscribed collection + first-paint gate); verbForVerdict->null and await waiting-not-stuck semantics pinned. No reducer/schema/keeper-py change.
## Evidence
