## Description

**Size:** M
**Files:** plugins/plan/src/{emit,invocation}.ts (emit), src/reducer.ts (minting), src/db.ts (row migration + SCHEMA_VERSION), keeper/api.py

### Approach

Flip the CLI emit to `plan_invocation` (`plugins/plan/src/emit.ts`/`invocation.ts`). Flip the reducer minting from `source='planctl'` to `source='plan'`. In the SAME migration/commit, `UPDATE file_attributions SET source='plan' WHERE source='planctl'` so stored rows match what re-fold now produces. Bump SCHEMA_VERSION + api.py same commit. The bounced daemon (fn-826) already reads `plan_invocation`, so nothing in flight breaks.

### Investigation targets

**Required**:
- plugins/plan/src/emit.ts, invocation.ts (the producer)
- src/reducer.ts:5191,5231,6953 (minting)
- src/db.ts (migration + SCHEMA_VERSION); keeper/api.py:284

### Risks

- Minting flip + row migration MUST be atomic (one `BEGIN IMMEDIATE`) or re-fold diverges from stored rows.
- Requires fn-826 landed + daemon bounced FIRST, else the still-intolerant daemon can't fold the new envelope → the worker can't close itself → stall. (This is the gate the split enforces.)

### Test notes

`bun run test:full`. Assert a fresh `plan_invocation` event folds `source='plan'`; existing `'planctl'` rows migrate; re-fold byte-identical.

## Acceptance

- [ ] CLI emits `plan_invocation`; reducer mints `source='plan'`; rows migrated; minting+migration atomic
- [ ] SCHEMA_VERSION + api.py same commit; re-fold byte-identical; `bun run test:full` green

## Done summary

## Evidence
