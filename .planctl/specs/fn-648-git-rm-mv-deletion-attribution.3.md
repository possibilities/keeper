## Description

**Size:** M
**Files:** src/db.ts, test/db.test.ts

### Approach

Bump `SCHEMA_VERSION` (src/db.ts:60) to the NEXT FREE value at implementation
time — check the live constant first; **fn-645 also claims v38**, so if it
landed first this targets v39. Add a forward-only, version-guarded migrate
slot (after the v36→v37 block, before the final meta stamp) modeled on the
v30→v31 backfill+rewind at src/db.ts:3313-3446: (1) walk `SELECT id, ... FROM
events WHERE tool_name='Bash' AND hook_event='PostToolUse'` and re-derive
`bash_mutation_kind`/`bash_mutation_targets` via the SHARED `extractBashMutation`
(defensive JSON.parse → (null,null) on malformed), then (2) rewind the reducer
cursor to 0 and `DELETE FROM {jobs, epics, git_status, file_attributions,
subagent_invocations}` so boot drain re-folds everything under the new reducer
match logic. The rewind is REQUIRED: the new match modes change historical
attributions, so without it stored projections diverge from a fresh re-fold
(violating the re-fold-determinism invariant). Version-guard so a re-run can't
corrupt an already-migrated schema.

### Investigation targets

**Required** (read before coding):
- src/db.ts:60 — SCHEMA_VERSION (current 37; verify at impl time vs fn-645)
- src/db.ts:3313-3446 — v30→v31 backfill (3359-3407) + cursor-rewind/DELETE
  (3439-3446) — the exact template
- src/db.ts:1471 + the v34/v35/v36 slots — version-guard idiom
- src/db.ts:38 — extractBashMutation import (shared deriver — do NOT fork)
- test/db.test.ts — the v31 backfill test (precedent for the v38 test)

### Risks

- **fn-645 schema-v38 collision** (same file, same migrate(), same version):
  coordinate — whoever lands second renumbers and rebases the migrate slot.
  This task is wired to depend on fn-645 to serialize.
- Backfill cost: re-derives ALL PostToolUse:Bash rows (the redirect fix widened
  the affected set beyond git). v31 was sub-second at ~10-20k rows; spot-check
  current event-log size.

### Test notes

Test: a pre-bump DB with a historical `git rm` event (NULL columns) migrates →
the event's columns are backfilled AND a re-fold attributes the deletion
(orphan healed). Re-running migrate is idempotent (version-guarded).

## Acceptance

- [ ] SCHEMA_VERSION bumped to the next free value; forward-only versioned slot.
- [ ] Backfill re-derives bash_mutation columns over historical
  PostToolUse:Bash rows via the shared deriver; malformed rows → (null,null).
- [ ] Cursor-rewind + DELETE-projections re-drain runs in the same guarded slot;
  a from-scratch re-fold reproduces identical healed projections.
- [ ] Migrate is idempotent on re-run; db.test.ts covers backfill + heal.

## Done summary

## Evidence
