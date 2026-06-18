## Overview

ADDITIVE step 1 of the daemon name-erasure. Make keeper's fold TOLERATE both the old (`planctl`) and new (`plan`) names WITHOUT changing any producer: the reducer reads both `planctl_invocation` and `plan_invocation` envelope keys and folds both `planctl-commit-changed`/`plan-commit-changed` event types; the `file_attributions` CHECK accepts both `'planctl'` and `'plan'`. Minting is UNCHANGED (still `'planctl'`), so a from-scratch re-fold reproduces byte-identical rows — re-fold determinism holds. This is the cascade-safety keystone: once the daemon is bounced onto this code, the next epic can flip producers with zero in-flight breakage, because the consumer already speaks both languages.

## Quick commands

- `bun run test:full` — fold accepts both envelope names + both source values
- after landing: **daemon bounce** (`launchctl kickstart -k …`) applies the new fold

## Acceptance

- [ ] `file_attributions` CHECK accepts BOTH `'planctl'` and `'plan'` (SCHEMA_VERSION bumped, `SUPPORTED_SCHEMA_VERSIONS` in api.py updated same commit) — additive, no rows changed
- [ ] reducer reads both `planctl_invocation` and `plan_invocation` envelope keys; folds both `planctl-commit-changed`/`plan-commit-changed`
- [ ] minting UNCHANGED (`source='planctl'`); from-scratch re-fold byte-identical (re-fold determinism preserved)
- [ ] `bun run test:full` green

## Rollout

AUTOPILOT-SAFE to land. BOUNDARY: this epic ends at a **daemon-bounce gate** — `await complete` this epic → notify → bounce the daemon (applies the tolerant fold) → arm the producer-flip epic. The bounce is why this is split from the flip.
