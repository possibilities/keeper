## Description

**Size:** M
**Files:** src/db.ts (v81 migration + badge CHECK), src/git-worker.ts (producer + wire-kind), src/derivers.ts (read), src/daemon.ts + src/plan-worker.ts (wire-kind dual-accept), keeper/api.py (SUPPORTED_SCHEMA_VERSIONS), test/refold-equivalence.test.ts

### Approach

The schema-migration tier (the ONLY schema-bumping task; never rides the `.1` mechanical commit). Three pieces, all version-guarded:
1. **Commit-event data keys (the keystone).** Add a v81 migration mirroring the v78 envelope rewrite (db.ts:4047-4199 is the template): rewrite the ~4,409 historical `events.data` Commit records' `planctl_op`/`planctl_target` → `plan_op`/`plan_target`, idempotent + version-guarded. THEN flip the producer (`git-worker.ts:1961-1962` emit `plan_op`/`plan_target`) and the read (`derivers.ts:1282-1305` read `obj.plan_op`) single-path. Because `commit_trailer_facts` is deterministic-replayed (byte-identical charter, in the rewind-DELETE list), extend `test/refold-equivalence.test.ts` (snapshots CTF at :761) to prove a from-scratch re-fold reproduces. Keep the frozen git-log trailer scrape (`git-worker.ts:959-960`) UNCHANGED — that reads immutable git history.
2. **Badge CHECK.** Narrow `file_attributions.source` CHECK (db.ts:1125) to drop `'planctl'` (0 live rows; safe table-rebuild). Verify NO fold path still mints the literal `'planctl'` (post-fn-831 it mints `'plan'`) — a mint under the narrowed CHECK would throw inside a fold and wedge the reducer.
3. **Wire-kind collapse.** Remove the `planctl-commit-changed` dual-accept branches (daemon.ts:2522, plan-worker.ts:3202, the union at git-worker.ts:243) — the producer already emits only `plan-commit-changed`. It's not persisted, so no re-fold impact; land it a generation AFTER the emit flip so no in-flight legacy message is dropped at a restart boundary (git-worker self-heals on next HEAD-oid anyway).
Bump SCHEMA_VERSION and add the new version to `SUPPORTED_SCHEMA_VERSIONS` in keeper/api.py in the SAME commit (test/schema-version.test.ts enforces).

### Investigation targets

**Required:**
- src/db.ts:4047-4199 (v78 rewrite — the exact migration template), :1125 (badge CHECK)
- src/git-worker.ts:1961-1962,1987,243; src/derivers.ts:1282-1305; src/daemon.ts:2522,2554-2562; src/plan-worker.ts:3202
- test/refold-equivalence.test.ts:761; keeper/api.py SUPPORTED_SCHEMA_VERSIONS; test/schema-version.test.ts

### Risks

- Re-fold dead-spot if the producer/read flip lands WITHOUT the historical events.data rewrite — the rewrite + the flip must land together.
- Never throw inside a fold: the narrowed badge CHECK must not be reachable by any minting fold path.
- Forward-only + idempotent; an old binary must not downgrade (migrate() guards on stored > binary SCHEMA_VERSION).

### Test notes

`bun run test:full` + extend refold-equivalence (from-scratch re-fold reproduces commit_trailer_facts byte-identical under plan_* keys). Confirm a re-fold over the 4,409 historical Commit events yields no null op/target.

## Acceptance

- [ ] v81 migration rewrites historical Commit-event data keys idempotently; producer + read flipped single-path; trailer scrape unchanged
- [ ] badge CHECK narrowed (no fold mints 'planctl'); wire-kind dual-accept collapsed safely
- [ ] SCHEMA_VERSION bumped + added to SUPPORTED_SCHEMA_VERSIONS same commit; refold-equivalence extended + green
- [ ] `bun run test:full` green

## Done summary
v82 migration retires the last live planctl residue: rewrites historical Commit-event events.data keys planctl_op/planctl_target → plan_op/plan_target (idempotent, value-preserving), flips producer+reader single-path with a spelling-tolerant v67 backfill, narrows the file_attributions.source CHECK to drop 'planctl', and collapses the planctl-commit-changed wire-kind dual-accept. SCHEMA_VERSION 82 + SUPPORTED_SCHEMA_VERSIONS; refold-equivalence extended + green; full suite green.
## Evidence
