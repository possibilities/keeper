## Overview

A deleted epic resurrects as a headerless "ghost" row on `keeper board`.
When `EpicDeleted` folds (`DELETE FROM epics`) and a later job-side fold —
a terminal `approve`/`SessionEnd` whose `plan_ref` points at the now-gone
epic — lands afterward, `syncJobIntoEpic` finds `epicRow == null` and
shell-INSERTs a scalar-NULL epics row (epic_number/title/project_dir/status
all NULL) to carry the embedded job. The board renders that as a
decapitated block at the top. Reproduced concretely on
`fn-637-throwaway-verify-fn-6356`: events EpicSnapshot, TaskSnapshot x2,
EpicDeleted (309028), TaskDeleted (309029), then SessionEnd (309032) for
approve session 9c587832 → shell reborn.

Fix: add a durable `epic_tombstones` projection. `EpicDeleted` mints a
tombstone row (keyed by epic_id, carrying the delete event id); a later
`EpicSnapshot` re-creating the same id clears it; every epic-shell-INSERT
site skips the INSERT when a tombstone is present, while still creating the
legitimate job-before-epic / task-before-epic shell for never-deleted
epics. End state: a deleted epic stays deleted; the existing ghost is
evicted automatically by the schema-migration re-fold.

## Quick commands

- `bun test test/reducer.test.ts` — reducer + re-fold-determinism suite
- `bun test test/schema-version.test.ts` — cross-language schema whitelist gate
- `sqlite3 ~/.local/state/keeper/keeper.db "SELECT epic_id FROM epics WHERE title IS NULL AND epic_number IS NULL;"` — after deploy, must return zero rows (ghost gone)
- `timeout 6 bun cli/board.ts; cat "$(ls -t /tmp/keeper-board.*.frame.*.txt | head -1)"` — board frame no longer opens with a headerless block

## Acceptance

- [ ] A new `epic_tombstones` projection table exists, fed only by the event log (minted by `EpicDeleted`, cleared by a re-creating `EpicSnapshot`).
- [ ] Every epic-shell-INSERT site (`projectPlanRow` TaskSnapshot arm, both `syncJobIntoEpic` arms, `syncPlanctlLinks`) skips the shell INSERT when the target epic is tombstoned; the legitimate before-arrival shell for never-deleted epics is preserved.
- [ ] `deleted_at_event_id` is `event.id` (never wallclock); the tombstone write + `DELETE FROM epics` + cursor bump ride one `BEGIN IMMEDIATE`; no fold throws.
- [ ] `SCHEMA_VERSION` bumped and `keeper/api.py` `SUPPORTED_SCHEMA_VERSIONS` gains the same int in the SAME change; `test/schema-version.test.ts` passes.
- [ ] Re-fold-determinism tests cover the full delete -> job-fold -> recreate -> job-fold interleaving and prove byte-identical `epics` + `epic_tombstones` rows; an assertion proves the ghost's event sequence yields zero scalar-NULL epic rows.
- [ ] The existing `fn-637-throwaway-verify-fn-6356` ghost is gone after the schema-migration re-fold (no manual DELETE into the projection).

## Early proof point

Task that proves the approach: `epic-tombstone-guard-against-ghost-resurrection.1`.
If it fails (e.g. the clear-on-recreate diverges on re-fold): fall back to a
retained `deleted` flag column on `epics` filtered from all serves, instead
of a separate table.

## References

- Repro epic `fn-637-throwaway-verify-fn-6356`: EpicSnapshot/TaskSnapshot x2/EpicDeleted(309028)/TaskDeleted(309029)/SessionEnd-approve(309032).
- `src/daemon.ts:350` — "every schema migration rewinds `reducer_state.last_event_id` and clears the projections": the bump itself triggers the from-scratch re-fold that evicts the ghost.
- Overlap with `fn-686-permission-and-elicitation-awaiting-pill` (open, keeper): both bump `SCHEMA_VERSION` + edit `src/reducer.ts`; fn-686 claims v52, so whichever lands second renumbers (no shared code path, pure version-number coordination).
- Practice basis: separate tombstone table over soft-delete column; `ON CONFLICT DO NOTHING` over `INSERT OR IGNORE`; never GC a tombstone while the log still references the id.

## Docs gaps

- **CLAUDE.md / AGENTS.md**: add `epic_tombstones` to the projection enumeration (cursor-transaction invariant, ~line 38) and to the re-fold `DELETE FROM` recipe; note the tombstone-skip predicate in the `syncJobIntoEpic` guard section (~152-168).
- **README.md**: revise the `epics`-projection tombstone-retract paragraph (~1005) to name the dual role (retract from `epics` + mint into `epic_tombstones`, cleared by `EpicSnapshot`); add an "As of schema v52 (fn-N)" changelog block after the v51 block (~1371).

## Best practices

- **Separate tombstone table, not a soft-delete column:** keeps the hot `epics` path compact and avoids `WHERE deleted=0` guards leaking into every read.
- **Atomic with the cursor:** mint the tombstone + `DELETE FROM epics` + `last_event_id` bump in one `BEGIN IMMEDIATE`, or a crash between them lets the resurrection survive restart.
- **Event-id, not wallclock:** `deleted_at_event_id = event.id` keeps re-fold byte-identical.
- **Don't GC tombstones** while the append-only log can still replay events referencing that id.

## Snippet context

No promptctl snippets attached: `find-snippets "event sourcing reducer projection determinism"` returned empty, and keeper's event-sourcing invariants live in its own CLAUDE.md (attached as a required investigation target in the task).
