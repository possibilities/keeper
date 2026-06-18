## Overview

Erase the name `planctl` from keeper's daemon: the `source='planctl'` attribution (a DB `CHECK` constraint → a forward-only schema migration), the `planctl_invocation` envelope (CLI↔reducer contract), the `planctl-commit-changed` event type, and `isVendoredPlanctlPath`. Target naming: `source='plan'`, `plan_invocation`, `plan-commit-changed`, `isVendoredPlanPath`. This is the sacred re-fold path — every change must reproduce byte-identical rows on a from-scratch re-fold.

## Quick commands

- `bun run test:full` — schema migration + re-fold-determinism tests
- `rg -n "planctl_invocation|'planctl'|planctl-commit-changed|isVendoredPlanctlPath" src plugins/plan/src` — should reach 0

## Acceptance

- [ ] schema migration 71→72 rebuilds `file_attributions` with `CHECK(source IN ('tool','bash','inferred','plan'))` + `UPDATE … SET source='plan' WHERE source='planctl'`, version-guarded; 72 added to `SUPPORTED_SCHEMA_VERSIONS` in `keeper/api.py` in the SAME commit
- [ ] reducer mints `source='plan'`; a from-scratch re-fold reproduces byte-identical rows
- [ ] `planctl_invocation` → `plan_invocation` on BOTH the CLI emit side (plugins/plan/src) and the reducer/types/derivers read side, renamed together
- [ ] `planctl-commit-changed` → `plan-commit-changed` (git-worker emit + plan-worker/reducer consume); `isVendoredPlanctlPath` → `isVendoredPlanPath`
- [ ] `bun run test:full` green

## Early proof point

Task `.1` (the schema migration) is the keystone — if re-fold determinism can't be held under the source rename, the whole erasure stalls here. Recovery: stage the source rename as an additive value first (CHECK accepts both), migrate rows, then drop the old value in a later version.

## References

- `src/db.ts:50` (SCHEMA_VERSION=71), `:1034`/`:2963` (the `source IN (...)` CHECK), `:2937` (prior CHECK-widening migration pattern to mirror).
- `keeper/api.py:284` (SUPPORTED_SCHEMA_VERSIONS).
- `planctl_invocation` sites: src/{reducer,types,derivers}.ts + plugins/plan/src/{emit,invocation,commit,cli}.ts + verbs.

## Rollout

Autopilotable as CODE. SUPERVISED DAEMON-RESTART CHECKPOINT after this epic: the running daemon folds with the old names until bounced; bounce it (LaunchAgent) to apply the migration + new contracts before arming epic 4. A worker LANDS+TESTS the migration in-process (template-DB harness); it does not migrate the live DB.
