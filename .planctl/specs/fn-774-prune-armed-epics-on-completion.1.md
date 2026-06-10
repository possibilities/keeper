## Description

**Size:** S
**Files:** src/reducer.ts, test/reducer-projections.test.ts, CLAUDE.md, README.md

### Approach

In `projectPlanRow`'s `EpicSnapshot` branch, add an unconditional-when-`done`
`DELETE FROM armed_epics WHERE epic_id = ?` keyed on `entityId`
(= `event.session_id`, the epic_id in this fold — NOT `snapshot.epic_id`,
which is the TaskSnapshot parent key), gated only on
`snapshot.status === 'done'`. Place it OUTSIDE the `ON-CONFLICT`
scalar-change carve-out — mirror the `epic_tombstones` DELETE at
`src/reducer.ts:804` — so it fires on EVERY `done` snapshot including
unchanged-scalar re-emits (placement inside the carve-out breaks re-fold
determinism on the arm-after-done interleaving). Use a bare `db.run` that
no-ops on a never-armed epic and never throws. Add a determinism comment
(mirror line 804's style) naming the EpicSnapshot fold as a SECOND
`armed_epics` writer alongside `foldEpicArmed`, and bind the `'done'`
literal to the canonical `epicIsCompleted` predicate (`epic-deps.ts:120`)
in the comment. Then update the docs (Docs gaps in the epic spec): CLAUDE.md
"Writes are tightly scoped" + "## Autopilot", README.md RPC paragraph +
schema v62 narrative block. No schema bump.

### Investigation targets

**Required** (read before coding):
- src/reducer.ts:786-958 — the `EpicSnapshot` branch of `projectPlanRow`; `snapshot.status` bound at line 842
- src/reducer.ts:804 — the model unconditional `epic_tombstones` DELETE (placement + comment style to mirror)
- src/reducer.ts:4225-4240 — `foldEpicArmed`, the existing `armed_epics` writer (the disarm DELETE shape to mirror)
- src/epic-deps.ts:120 — `epicIsCompleted` = `status === "done"` (canonical predicate; keep the literal consistent)
- test/reducer-projections.test.ts:1931-1972 — existing `armed_epics` test block; helpers: `epicSnapshotEvent` (:254), `epicArmedEvent` (:1793), `getArmedEpics` (:1805), `getCursor` (:197), `drainAll` (:223)

**Optional** (reference as needed):
- CLAUDE.md "Writes are tightly scoped" / "## Autopilot" sections
- README.md RPC surface paragraph (~193-196) + schema v62 narrative block (~1647-1651)

### Risks

- Placement inside the `ON-CONFLICT` scalar-change carve-out skips the DELETE on unchanged-scalar re-emits → re-fold determinism break on the arm-after-done interleaving. Must sit outside, like line 804.
- Keying on `snapshot.epic_id` instead of `entityId` prunes the wrong row (or nothing).
- The prune must live ONLY in the `EpicSnapshot` arm, never the TaskSnapshot `else` arm (a task event has no epic-level status).
- Strict `=== 'done'` (not truthiness) so a null/missing status no-ops instead of throwing.

### Test notes

- arm an epic → fold a `{status:'done'}` EpicSnapshot for it → `getArmedEpics()` empty, `getCursor()` advanced
- DELETE on a never-armed `done` epic → no-op, no throw, cursor advances (the common case — most done epics were never armed)
- re-fold from cursor 0 over `[EpicArmed X true, EpicSnapshot X done]` → zero `armed_epics` rows for X (determinism)
- a second `done` snapshot for the same epic → harmless no-op

## Acceptance

- [ ] `projectPlanRow` deletes the `armed_epics` row when an `EpicSnapshot` folds the epic to `status='done'`, keyed on `entityId`, placed outside the `ON-CONFLICT` carve-out
- [ ] the prune is a bare `db.run` that no-ops on a never-armed epic and never throws (strict `=== 'done'` gate)
- [ ] reducer-projections.test.ts covers prune-on-done, no-op-on-never-armed, re-fold-from-empty determinism, and repeat-done-snapshot idempotence
- [ ] CLAUDE.md ("Writes are tightly scoped" + "## Autopilot") and README.md (RPC paragraph + schema v62 block) note the EpicSnapshot fold as a second `armed_epics` writer
- [ ] no schema bump (no `SCHEMA_VERSION` / `SUPPORTED_SCHEMA_VERSIONS` change)

## Done summary
EpicSnapshot fold now prunes the armed_epics row when an epic folds to status='done', making it a second writer of armed_epics alongside foldEpicArmed. Placed outside the ON-CONFLICT carve-out (mirrors the epic_tombstones clear) so it fires on every done snapshot and re-fold reproduces zero rows. No schema bump; docs updated.
## Evidence
