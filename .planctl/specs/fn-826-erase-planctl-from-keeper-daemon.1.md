## Description

**Size:** M
**Files:** src/db.ts (migration + SCHEMA_VERSION bump + the two CHECK sites), keeper/api.py (SUPPORTED_SCHEMA_VERSIONS), src/reducer.ts (the `source='planctl'` minting), test/db.test.ts + a re-fold test

### Approach

Bump `SCHEMA_VERSION` 71→72. Add a version-guarded migration that rebuilds `file_attributions` (SQLite can't ALTER a CHECK) with `CHECK(source IN ('tool','bash','inferred','plan'))`, copying rows and `UPDATE … SET source='plan' WHERE source='planctl'`. Update the live-table DDL (`db.ts:1034`) to the new CHECK. Add 72 to `SUPPORTED_SCHEMA_VERSIONS` in `keeper/api.py` IN THE SAME COMMIT (`test/schema-version.test.ts` enforces this). Change the reducer's attribution minting from `source='planctl'` to `source='plan'`. The fold must stay deterministic: a from-scratch re-fold reproduces `source='plan'` rows byte-identically (schema defaults match the zero-event projection).

### Investigation targets

**Required**:
- src/db.ts:2937-2965 — the prior CHECK-widening migration (the table-rebuild pattern to mirror)
- src/db.ts:1034 — the live `file_attributions` DDL CHECK
- src/reducer.ts:5191,5231,6953 — the `source='planctl'` minting sites
- keeper/api.py:284 — SUPPORTED_SCHEMA_VERSIONS frozenset
- test/schema-version.test.ts — the api.py whitelist enforcement; test/db.test.ts — migration test pattern

### Risks

- SQLite CHECK can't be altered in place → full table rebuild inside one `BEGIN IMMEDIATE`; preserve all columns/indexes/rowids.
- Re-fold determinism: the minting rename + the migration must agree so an empty re-fold AND a populated re-fold both reproduce `source='plan'`.
- Forgetting api.py 72 fails every keeper-py read — same-commit, enforced by test.

### Test notes

Use the template-DB harness (`freshDb`) for the migration test; assert a 71-DB with `source='planctl'` rows migrates to `source='plan'` and that a from-scratch re-fold of a populated event log reproduces identical rows. `bun run test:full`. This LANDS code; the live daemon applies it on the supervised restart after this epic.

## Acceptance

- [ ] SCHEMA_VERSION=72; migration rebuilds `file_attributions` with the `'plan'` CHECK + migrates existing `'planctl'` rows; version-guarded
- [ ] 72 in `SUPPORTED_SCHEMA_VERSIONS` (same commit); `test/schema-version.test.ts` green
- [ ] reducer mints `source='plan'`; from-scratch re-fold byte-identical
- [ ] `bun run test:full` green

## Done summary

## Evidence
