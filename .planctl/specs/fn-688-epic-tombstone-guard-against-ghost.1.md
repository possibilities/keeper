## Description

**Size:** M
**Files:** src/db.ts, src/reducer.ts, keeper/api.py, test/reducer.test.ts, CLAUDE.md, README.md

### Approach

Add a new `epic_tombstones` projection table and make every epic-shell-INSERT
site consult it so a deleted epic cannot be resurrected as a scalar-NULL ghost
row, while the legitimate before-arrival shell for never-deleted epics is
preserved.

1. **Schema (`src/db.ts`).** Bump `SCHEMA_VERSION` (currently 51 at `src/db.ts:61`
   — claim the next free int; coordinate with fn-686 which also claims v52, the
   second-to-land renumbers). Add `CREATE TABLE IF NOT EXISTS epic_tombstones
   (epic_id TEXT PRIMARY KEY, deleted_at_event_id INTEGER NOT NULL)` to the
   bootstrap CREATE list in `migrate()` (mirror `CREATE_PENDING_DISPATCHES`,
   `src/db.ts:1276-1285` — a table create, NOT the column-add `addColumnIfMissing`
   template). Add a version-slotted no-op/doc-comment block for v51->v52 mirroring
   the v50->v51 slot (`src/db.ts:4989`); a brand-new empty table needs no backfill.
   Add `epic_tombstones` to any rewind/wipe projection list the codebase maintains.
2. **Mint on delete (`retractPlanRow` EpicDeleted arm, `src/reducer.ts:943-983`).**
   In the same `BEGIN IMMEDIATE` that does `DELETE FROM epics` + `DELETE FROM
   epic_dep_edges` + reverse fan-out, UPSERT the tombstone: `INSERT INTO
   epic_tombstones (epic_id, deleted_at_event_id) VALUES (?, ?) ON CONFLICT(epic_id)
   DO NOTHING`, with `deleted_at_event_id = event.id` (never wallclock). Mint
   unconditionally (independent of whether a prior epics row existed) so a
   delete-before-snapshot or double-delete still tombstones.
3. **Clear on recreate (`projectPlanRow` EpicSnapshot arm, `src/reducer.ts:608-673`).**
   A legitimate re-create of the same id clears the tombstone: `DELETE FROM
   epic_tombstones WHERE epic_id = ?`. Place the clear OUTSIDE the ON-CONFLICT
   scalar carve-out (it must run unconditionally in the EpicSnapshot arm, not only
   when scalar columns change), so a re-fold reproduces it byte-deterministically.
4. **Guard every shell-INSERT site.** Introduce one shared helper, e.g.
   `insertEpicShellIfNotTombstoned(db, epicId, ...)`, that performs the shell INSERT
   only when `NOT EXISTS (SELECT 1 FROM epic_tombstones WHERE epic_id = ?)`, and
   route ALL shell-INSERT sites through it: `projectPlanRow` TaskSnapshot arm
   (`src/reducer.ts:912`), `syncJobIntoEpic` epic-kind arm (`:4227`), `syncJobIntoEpic`
   task-kind arm (`:4359`), and `syncPlanctlLinks` (`:4690`, if it shell-inserts).
   The real full-scalar EpicSnapshot INSERT (`:638`) is NOT a shell site and is not
   guarded (it is the clear site). Scope each guard to the existing `epicRow == null`
   branch — a present row still UPDATEs normally.
5. **keeper-py (`keeper/api.py:170-172`).** Add the new int to `SUPPORTED_SCHEMA_VERSIONS`
   in THIS change with a whitelist-only doc comment (mirror the v51 comment). keeper-py
   reads no plan/epic surface — no reader logic change.
6. **Docs.** Update CLAUDE.md/AGENTS.md (projection enumeration + re-fold recipe +
   syncJobIntoEpic guard note) and README.md (epics-projection tombstone paragraph +
   schema v52 changelog block).

### Investigation targets

**Required** (read before coding):
- CLAUDE.md (keeper) "Event-sourcing invariants" + "DO NOT" — the cursor-in-one-tx, re-fold-determinism, and never-throw-in-fold rules this change must honor
- src/reducer.ts:943-983 — `retractPlanRow` EpicDeleted arm (mint site)
- src/reducer.ts:608-673 — `projectPlanRow` EpicSnapshot arm (clear site; note the ON-CONFLICT carve-out the clear must sit outside)
- src/reducer.ts:4198-4232 and :4348-4363 — the two `syncJobIntoEpic` shell arms
- src/reducer.ts:911-916 — `projectPlanRow` TaskSnapshot shell-INSERT (third vector)
- src/reducer.ts:4690, :4931 — `syncPlanctlLinks` (fourth potential vector)
- src/db.ts:61, :1276-1285, :2038, :4989-5079, :5088 — SCHEMA_VERSION, table template, migrate(), v50->v51 slot, version stamp
- src/daemon.ts:350 — confirms schema migration rewinds the cursor + clears projections (the auto-eviction mechanism)
- keeper/api.py:170-172 — SUPPORTED_SCHEMA_VERSIONS frozenset

**Optional** (reference as needed):
- test/reducer.test.ts:50, :2992, :3149 — insertEvent helper + re-fold-determinism recipe (rewind last_event_id=0, DELETE projections incl. the new table, redrain, toEqual)
- test/schema-version.test.ts — mechanical keeper-py whitelist gate

### Risks

- **Re-fold determinism on the delete->recreate interleaving.** The clear-on-recreate must reproduce identically under a cursor=0 re-fold; misplacing it behind the scalar carve-out diverges. Covered by a dedicated test.
- **Incomplete site coverage.** Guarding only the two named `syncJobIntoEpic` arms leaves TaskSnapshot/syncPlanctlLinks as open resurrection doors; route ALL shell sites through the shared helper.
- **Schema-number collision with fn-686.** Both claim v52; second-to-land renumbers the migrate slot int + keeper-py int. Pure version-number coordination, no shared code path.

### Test notes

- Re-fold-determinism test over the reproduction sequence (EpicSnapshot, TaskSnapshot x2, EpicDeleted, TaskDeleted, SessionEnd-approve whose plan_ref points at the deleted epic): live drain vs. rewind+wipe(+`epic_tombstones`)+redrain produce byte-identical `epics` and `epic_tombstones` rows.
- Assertion: after that sequence, `SELECT * FROM epics WHERE epic_id = '<deleted>'` returns zero rows (no scalar-NULL shell).
- Preserve the legit path: a job-before-epic fold for a NEVER-deleted epic still creates the shell (no tombstone present).
- shell -> delete -> shell: a second job fold after EpicDeleted skips; delete -> recreate -> job fold: the recreate clears the tombstone so the later shell is allowed again.
- `bun test test/reducer.test.ts test/schema-version.test.ts` green.

## Acceptance

- [ ] `epic_tombstones (epic_id TEXT PRIMARY KEY, deleted_at_event_id INTEGER NOT NULL)` created in `migrate()`; minted by `EpicDeleted`, cleared by `EpicSnapshot`, both inside the fold's `BEGIN IMMEDIATE`.
- [ ] All four epic-shell-INSERT sites route through one tombstone-checking helper and skip resurrection when tombstoned; never-deleted before-arrival shells still land.
- [ ] `deleted_at_event_id = event.id`; no fold reads wallclock/env/fs; no fold throws.
- [ ] `SCHEMA_VERSION` bumped and `keeper/api.py` `SUPPORTED_SCHEMA_VERSIONS` gains the same int in the same change; `test/schema-version.test.ts` passes.
- [ ] Re-fold-determinism test over the delete->job->recreate->job interleaving passes; zero scalar-NULL epic rows after the ghost sequence.
- [ ] CLAUDE.md/AGENTS.md + README.md updated (projection enumeration, re-fold recipe, guard note, schema v52 changelog).
- [ ] `bun test` green.

## Done summary

## Evidence
