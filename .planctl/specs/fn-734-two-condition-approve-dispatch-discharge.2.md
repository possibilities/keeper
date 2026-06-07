## Description

**Size:** M
**Files:** src/reducer.ts, test/reducer.test.ts

### Approach

Fix the dup-dispatch race where an `approve` worker is re-dispatched in the
window between the approver job going terminal and the approval folding
into `epics`. Two parts:

PART A — keep the approve `pending_dispatches` row alive past SessionStart:
at the discharge-on-bind site (~src/reducer.ts:6814-6832), add
`&& plan_verb !== "approve"` to the spawn-INSERT discharge so an approve
row is no longer cleared at bind. (Resume already never discharges; the
`isSpawnInsert` gate is unchanged for non-approve verbs.)

PART B — discharge the approve row only when BOTH (a) approval resolved
(`epics` approval in {approved, rejected}, not pending) AND (b) approve job
terminal (`jobs.state` in {ended, killed}), fired by whichever folds SECOND
via a cross-table read:
- Terminal side: in SessionEnd->'ended' (~7141-7176) and Killed->'killed'
  (~7178-7239), AFTER the terminal UPDATE (gate on res.changes > 0), read
  the just-terminal job's `plan_verb`/`plan_ref`; if `plan_verb === "approve"`,
  route `plan_ref` via `parsePlanRef` -> read `epics.approval` (epic-kind)
  or `epics.tasks[].approval` (task-kind); if resolved, idempotent
  `DELETE FROM pending_dispatches WHERE verb='approve' AND id=plan_ref`.
- Approval side: in the approval fold arms (TaskSnapshot ~943-1017 writing
  `epics.tasks[].approval` line 1014; EpicSnapshot ~761-837 writing
  `epics.approval` line 809), when approval becomes resolved, SELECT the
  `(plan_verb='approve', plan_ref=entityId)` job; if its state is terminal,
  the same idempotent DELETE.

Each side INDEPENDENTLY re-checks "is the OTHER condition already true in
persisted state" and DELETEs only when both hold -> commutative,
re-fold-deterministic under keeper's fixed single-writer log order. The
existing 120s `DispatchExpired` TTL (src/daemon.ts:264) remains the
backstop for the crashed-approver case (job terminal, approval never
folds): a fresh approver re-dispatches after <=120s.

Add a small `(plan_verb, plan_ref)` job selector (none exists today) and a
task-approval reader — reuse the `syncJobIntoEpic` (~4677) SELECT-tasks +
JSON.parse-with-`[]`-fallback + `find(t => t.task_id === ...)` idiom. Reuse
`parsePlanRef` (src/derivers.ts:444) as the ONLY ref-splitter. Terminal
constants `ENDED = "ended"` (177), `KILLED = "killed"` (191). Confirmed:
`plan_verb === "approve"` literal is safe (planVerbRefFromSpawnName,
derivers.ts:169-181).

NB (fn-732 dependency): fn-732 lands first and reworks the approval SOURCE
and fold path (sidecar `epic-state`/`task-state` events). Re-confirm the
THEN-current approval-fold arm names/locations and the discharge-on-bind
site after fn-732 — the line anchors here are PRE-fn-732 and will have
moved/renamed. The two-condition invariant is unchanged; only the arm
locations and the approval source shift.

### Investigation targets

**Required** (read before coding):
- src/reducer.ts:6814-6832 — discharge-on-bind (Part A gate); `isSpawnInsert` derivation 6709-6712
- src/reducer.ts:7141-7176 — SessionEnd->'ended'; 7178-7239 — Killed->'killed' (both already call `syncIfPlanRef` — the cross-table-read precedent; Killed pre-SELECTs pid/start_time)
- src/reducer.ts:761-837 — EpicSnapshot (approval scalar, line 809); 943-1017 — TaskSnapshot (embedded approval, line 1014)
- src/derivers.ts:444 — `parsePlanRef`; 169-181 — `planVerbRefFromSpawnName`
- src/reducer.ts:4677 — `syncJobIntoEpic` (SELECT tasks + parse-`[]`-fallback + find idiom); 3640-3643 — `foldDispatchFailed` discharge model
- src/daemon.ts:264 — `PENDING_DISPATCH_TTL_MS = 120000`; 318-336 — `selectExpiredPendingDispatches` (anchors on `dispatched_at`)
- test/reducer.test.ts:14158 — pending_dispatches block; 14382-14441 — discharge-on-bind tests; 14487 / 14517 — re-fold determinism (mandatory dual-order coverage)

**Optional** (reference as needed):
- src/db.ts:1219-1275 — `pending_dispatches` schema + "row presence IS the signal" comment; 4836 — re-fold DELETE reset list
- src/readiness.ts:1006-1030 — fn-721 `dispatch-pending` occupant (verify extended-life sibling-demotion doesn't wedge; largely redundant with predicate-7 job-pending)

### Risks

- Re-fold determinism is SACRED: both discharge arms must be pure functions
  of persisted projection state + event payload (no Date.now/env/fs).
  Idempotent DELETE. NEVER throw — malformed plan_ref / missing job /
  malformed `epics.tasks` -> safe no-op (row left for the TTL).
- "Row presence IS the signal" (db.ts:1219): keeping an approve row alive
  re-interprets it for 3 consumers — `liveTabKeys` (DESIRED: this IS the
  fix), the fn-721 occupant (longer sibling-demotion; verify no wedge), and
  `isReapCandidate` (handled by the sibling reaper task, ordinal 1).
- fn-727 `isCompletionReapCandidate` fires on `{tag:completed}`, which
  requires approval folded -> the pending row is already discharged by
  then; add a test confirming no reap race.
- TTL couples correctness to approval-fold lag < 120s (was 59s in the
  incident). Accepted; the never-folds -> TTL path must be tested.

### Test notes

- Dual-order re-fold (MANDATORY, mirror test 14517): (i) approval folds then
  job terminal; (ii) job terminal then approval folds — both converge to
  row-absent, byte-identical re-fold.
- Incident order: Dispatched(approve) -> SessionStart spawn-INSERT [row
  PERSISTS] -> SessionEnd 'ended' with approval still pending [row PERSISTS]
  -> TaskSnapshot approved [row DISCHARGED].
- Reverse: approval=approved while job working [persists] -> SessionEnd [discharged].
- Crashed approver: SessionEnd 'ended', approval pending forever -> row
  persists, `DispatchExpired` at TTL fires -> row gone (no premature
  discharge before TTL).
- Rejected: `rejected` satisfies condition (a) -> discharges with terminal job.
- Close-row/epic: mirror incident + reverse for EpicSnapshot + approve job
  keyed by epic id + `epics.approval` scalar.
- Update the 4 discharge-on-bind tests (14382-14441): work-verb still
  discharges on bind; ADD an approve-verb spawn-INSERT case asserting the
  row PERSISTS.

## Acceptance

- [ ] Approve `pending_dispatches` row survives SessionStart spawn-INSERT (Part A); work/close still discharge on bind
- [ ] Row discharges exactly when BOTH approval resolved (approved|rejected) AND approve job terminal (ended|killed), from whichever folds second — task AND close-row paths
- [ ] Crashed approver (job terminal, approval never folds) -> row persists until the 120s `DispatchExpired` TTL; no premature discharge, no premature re-dispatch
- [ ] Byte-identical re-fold holds for BOTH fold orders (dual-order tests mirroring 14517)
- [ ] No throw on malformed plan_ref / missing job / malformed `epics.tasks` (safe no-op, cursor advances)
- [ ] `SCHEMA_VERSION` unchanged (60); no schema / keeper/api.py change
- [ ] New `(plan_verb, plan_ref)` job selector + task-approval reader added (or `syncJobIntoEpic` idiom reused); `parsePlanRef` reused as the sole ref-splitter

## Done summary

## Evidence
