## Overview

The close-finalize arm chokepoint deliberately excludes the partial_followup
outcome so a half-built follow-up tree stays a non-dispatchable null ghost.
That exclusion is currently guarded only by a code comment plus the structural
fact that the partial path never reaches the arm block — no test asserts it.
This follow-up adds the missing regression assertion so a future refactor that
armed all follow-ups can't silently make an under-provisioned epic dispatchable.

## Acceptance

- [ ] The partial_followup test asserts the scaffolded follow-up's last_validated_at stays null after finalize.
- [ ] bun test stays green.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept   | .1 | saga-close-finalize.test.ts:566-573 asserts outcome/status but not the follow-up null ghost; the partial exclusion at close_finalize.ts:638-644 is comment-only. |
| F2 | culled | —  | close_finalize.ts:654 arm-failure fold is sound and reachable only via commit-failure injection; the invariant is already held by the load-bearing comment and the crash-resume test at line 360. |

## Out of scope

- Testing the arm commit-failure fold (F2) — sound behavior, hard-path injection, comment-documented invariant; deferred.
- Any change to close-finalize behavior; this is test-coverage only.
