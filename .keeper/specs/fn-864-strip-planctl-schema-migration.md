## Overview

Phase 2 of the planctl→plan strip: the v77→v78 schema-migration keystone.
Rename every `planctl_*` schema surface → `plan_*` (the `events` sparse
columns + 3 partial indexes, and the `commit_trailer_facts` projection
columns + index), rewrite the ~9.5k historical `events.data`
`planctl_invocation` envelopes → `plan_invocation`, flip ALL readers/writers
single-path (drop the `?? planctl_invocation` coalesce), and rename the
schema/fold-layer `planctl`-named code symbols. End state: the steady-state
fold reads single-path `plan_*` and no canonical event carries the legacy
envelope key. The riskiest epic of the strip — one atomic, value-preserving,
NO-cursor-rewind migration, gated by a re-fold-equivalence proof.

## Quick commands

- `sqlite3 -readonly ~/.local/state/keeper/keeper.db "SELECT count(*) FROM events WHERE COALESCE(data,'') LIKE '%planctl_invocation%'"` → `0` after migrate
- `sqlite3 -readonly ~/.local/state/keeper/keeper.db "SELECT count(*) FROM events WHERE plan_op IS NOT NULL"` → matches the pre-migrate `planctl_op` count
- `rg -n 'planctl_(op|target|epic_id|task_id|invocation)' src/ --glob '!src/db.ts'` → no live reads after .1 (db.ts retains them only in the frozen ladder + the v78 rename call)
- `bun run test:full`

## Acceptance

- [ ] v78 migration renames all `planctl_*` columns/indexes → `plan_*` and rewrites historical `events.data` envelopes; `COUNT(planctl_invocation)==0` asserted post-rewrite
- [ ] Steady-state fold is single-path `plan_*`; the `?? planctl_invocation` coalesce is gone; `bun run test:full` + the re-fold-equivalence proof pass
- [ ] `keeper/api.py` SUPPORTED_SCHEMA_VERSIONS contains 78 in the same commit

## Early proof point

Task that proves the approach: `.1` — specifically the re-fold-equivalence
proof seeding a `planctl_invocation`-only legacy row and asserting the
migrated path folds byte-identically to a from-scratch fold of the rewritten
corpus. If it fails: the rewrite missed a row shape or the reader flip
diverged — fix before the coalesce drop is trusted.

## References

- `docs/planctl-strip.md` §5 Problem A (the source spec; panel-vetted) — but note its mechanics are superseded: panel chose ALTER RENAME COLUMN + NO cursor rewind (the fn-831 pattern at `db.ts:3720`), NOT the fn-856 rewind+wipe pattern.
- SCHEMA_VERSION is already 77 (fn-856 landed) → this epic is v77→v78.
- `fn-859` (open, Phase 1) co-edits README.md + CLAUDE.md docs in different sections — advisory soft overlap on the `.2` docs task, not a hard dep.
- Decision A (human): keep the CREATE literal + frozen ladder steps as `planctl_*` (schema history); v78 renames forward. Decision B (human): scope the symbol rename to the schema/fold layer; trailer parsers → Problem B, plan-dir + `PlanctlCondition` → deferred follow-up.

## Docs gaps

- **README.md / CLAUDE.md / plugins/plan/CLAUDE.md / plugins/plan/skills/hack/SKILL.md**: forensics sqlite recipes query `planctl_op/epic_id/task_id` + `idx_events_planctl_*` and BREAK after the rename — fixed in task `.2`. The SKILL.md recipes are baked from `promptctl render engineering/keeper-history-forensics`; the canonical snippet (may live outside this repo) must update too or a re-bake reverts them — `.2` flags this.
- **docs/planctl-strip.md**: §2/§5/§6/§9 updates owned by the planning session (orchestrator), NOT a worker task.

## Best practices

- `ALTER TABLE RENAME COLUMN` is metadata-only (O(1), rowid-preserving) and AUTO-rewrites partial-index WHERE predicates + trigger/view/CHECK refs [SQLite docs] — so the index DROP/CREATE is only to rename the index *identifier*, done AFTER the column rename. (`events` has no triggers/views — RENAME is semantic-ambiguity-safe.)
- Doubly-nested JSON rewrite: app-level parse/swap-key/re-embed (NOT `json_set` — the envelope sits inside a stdout JSON *string*); `json_valid` guard; idempotent by key-presence; preserve original stdout bytes; one `BEGIN IMMEDIATE`, no chunking at ~9.5k rows; explicit ROLLBACK on catch [practice-scout / SQLite docs].

## Rollout

Human-owned prerequisite before the FIRST live migrate: `PRAGMA wal_checkpoint(TRUNCATE)` then copy the `.db` (the one-shot rollback target — restore the v77 DB + a pre-v78 binary). The migration is forward-only + version-guarded + idempotent; a crash mid-`.immediate()` rolls back to v77 and the next boot retries. Post-migrate: `PRAGMA integrity_check` + `foreign_key_check` on a read-only connection.
