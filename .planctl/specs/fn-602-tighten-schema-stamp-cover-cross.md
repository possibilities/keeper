## Overview

Two tight loose ends surfaced by the fn-598 audit. The `SCHEMA_VERSION = 15`
stamp introduced for the `git_status` table is missing its guarded ALTER
block, so any future v14 to v15 migration step would silently no-op on
already-stamped DBs. Separately, the cross-session sweep in
`syncPlanctlLinks` is a load-bearing re-derive path with no test — a
silent regression there would leak stale `job_links` edges that a re-fold
from scratch would not reproduce.

## Acceptance

- [ ] `SCHEMA_VERSION` stamp is honest: either downgraded to 14, or paired
      with a guarded `if (storedVersion < 15)` block in `migrate()` that
      documents what the bump gates.
- [ ] A reducer test exercises the cross-session sweep path in
      `syncPlanctlLinks`: session A drops a refiner edge and session B's
      classifier re-derives, asserting both sides' `epic_links` and the
      touched epic's `job_links` reach the correct post-state.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1     | kept   | .1   | SCHEMA_VERSION bump without guarded ALTER — concrete future-correctness risk: real v14 to v15 ALTER will silently no-op on already-stamped DBs |
| F2     | kept   | .2   | Cross-session re-derive in `syncPlanctlLinks` is untested; the re-derive-from-scratch correctness invariant depends on this branch |
| F3     | culled | —    | O(N*M) sweep cost is acknowledged in a code comment; no user impact at expected planctl volumes — revisit only if volume grows |
| F4     | culled | —    | Unused `planctl_task_id` SELECT column is read amplification only, not user-visible |
| F5     | culled | —    | Template-string placeholder construction is structurally safe; the "looks like SQL injection" concern is purely visual |
| F6     | culled | —    | Defensive `Number.isFinite` checks are intentional belt-and-suspenders; auditor explicitly says keep for re-fold determinism |
| F7     | culled | —    | Quote-stripping edge case on escaped-inner quotes is theoretical — planctl IDs never contain quotes |

## Out of scope

- The `git_status` table and `git-worker` subsystem (lives in commit `b1271a8`; fn-598 only touched the `SCHEMA_VERSION` stamp by scope-leak in commit `7e6cb35`)
- `syncPlanctlLinks` performance optimization (revisit only if planctl-CLI volume grows; today the cost is acknowledged in a code comment)
