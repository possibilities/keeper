## Description

**Size:** M
**Files:** src/db.ts (CHECK widen + SCHEMA_VERSION), keeper/api.py, src/derivers.ts + src/reducer.ts (envelope reader)

### Approach

Widen the `file_attributions` CHECK to `source IN ('tool','bash','inferred','planctl','plan')` — additive, both allowed. SQLite can't ALTER a CHECK, so rebuild the table copying rows verbatim (rows unchanged → re-fold byte-identical). Bump SCHEMA_VERSION; add it to `SUPPORTED_SCHEMA_VERSIONS` in `keeper/api.py` SAME commit. Teach the reducer's envelope reader to accept BOTH `planctl_invocation` and `plan_invocation` keys (`derivers.ts:442`, `reducer.ts:5169,5180`). Do NOT change minting — it still produces `source='planctl'`. This is purely "consumer learns the new word too."

### Investigation targets

**Required**:
- src/db.ts:1034,2963 (the CHECK), :2937 (table-rebuild migration pattern), :50 (SCHEMA_VERSION)
- src/derivers.ts:390,442 + src/reducer.ts:5150-5180 (envelope reader to widen)
- keeper/api.py:284 (SUPPORTED_SCHEMA_VERSIONS); test/schema-version.test.ts

### Risks

- Table rebuild must copy rows verbatim (no source change) or re-fold determinism breaks.
- A reader that accepts both must not double-count when a single event somehow has both keys — prefer `plan_invocation` if present, else `planctl_invocation`.

### Test notes

`bun run test:full`. Assert: a `planctl_invocation` event AND a `plan_invocation` event both fold to a `source='planctl'` row (minting unchanged); from-scratch re-fold of the live event log reproduces identical rows.

## Acceptance

- [ ] CHECK accepts both source values (additive); table rebuilt copying rows verbatim
- [ ] reducer reads both envelope keys; minting still `'planctl'`; re-fold byte-identical
- [ ] SCHEMA_VERSION + api.py same commit; `bun run test:full` green

## Done summary
Widened file_attributions.source CHECK to accept 'plan' alongside 'planctl' (v72 row-preserving table rebuild, no rewind) and taught the reducer's envelope readers (extractPlanctlInvocation + extractPlanctlStateRepo) to prefer plan_invocation, falling back to planctl_invocation. Minting unchanged (source='planctl'), re-fold byte-identical.
## Evidence
