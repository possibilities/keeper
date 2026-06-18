## Overview

ADDITIVE step 2 of the daemon name-erasure — runs only AFTER fn-826 lands and the daemon is bounced onto the both-tolerant fold. Now flip the PRODUCERS to the new names and migrate the stored projection: the CLI emits `plan_invocation`, the reducer mints `source='plan'`, the git-worker emits `plan-commit-changed`, and a migration rewrites existing `source='planctl'` rows to `'plan'`. Because the bounced daemon already accepts both, a worker emitting the new name folds cleanly and can report its own `done` — no stall. Re-fold determinism holds: minting now yields `'plan'` AND stored rows are migrated to `'plan'`, so a from-scratch re-fold matches.

NOTE — the one mandatory residual: the `planctl_invocation` READER stays forever. 19,850 immutable historical events carry that envelope; re-fold must replay them, so the reader is a permanent (clearly-commented) legacy path. Only the PROJECTION value (`source`) and the PRODUCERS are erased here.

## Quick commands

- `keeper plan status` then check a fresh event folds `source='plan'`
- `bun run test:full`; after landing: **daemon bounce** applies the new minting

## Acceptance

- [ ] CLI emits `plan_invocation`; reducer mints `source='plan'`; git-worker emits `plan-commit-changed`
- [ ] migration rewrites existing `source='planctl'` rows → `'plan'` (SCHEMA_VERSION + api.py same commit)
- [ ] from-scratch re-fold byte-identical (mints `'plan'`, rows migrated to match)
- [ ] the `planctl_invocation` legacy reader is retained + commented as historical-event compat; `bun run test:full` green

## Early proof point

Task `.1` (emit + mint + migrate) is the keystone. If re-fold diverges, the migration and the minting flip aren't atomic — land both in one `BEGIN IMMEDIATE`.

## Rollout

AUTOPILOT-SAFE to land (the bounced daemon tolerates the new emissions). BOUNDARY: ends at a **daemon-bounce gate** → `await complete` → notify → bounce → arm fn-827.
