## Overview

The keeper dash process shell (`createDashApp` in `src/dash/app.ts`) and its
forked exit triggers (`src/dash/exit-triggers.ts`) own the most consequential
behavior in the dash epic — terminal-restore-before-exit on every exit path —
yet ship with no direct test. The arming seam (`armExitTriggers`) was built
injectable specifically to enable this test, but it was left unwritten. This
follow-up closes that test-coverage gap so a future regression cannot silently
strand a real user's terminal in alt-screen/raw mode.

## Acceptance

- [ ] `createDashApp`'s teardown discipline (idempotent exit, terminal destroy before process.exit, onFatal/uncaughtException routing) is asserted by a direct test using the injectable `armExitTriggers` stub.
- [ ] `armViewerExitTriggers` in `src/dash/exit-triggers.ts` has coverage or a parity pin so it cannot drift silently from its `src/view-shell.ts` source.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | culled | — | TDZ trap (app.ts:404-432) is unreachable today; hardening against a hypothetical future change, no current defect. |
| F2 | culled | — | exitCleanly/onFatalError teardown duplication is a local DRY/style preference with no user impact. |
| F3 | culled | — | Uncommitted app.ts edit is a benign type-only provenance flag, not a defect in the audited commit set. |
| F4 | kept | .1 | createDashApp terminal-restore-before-exit path has no direct test though the arming seam was made injectable for one. |
| F5 | merged-into-F4 | .1 | F5 (exit-triggers.ts fork parity test) folds into F4: both are the dash exit/teardown coverage gap, same test file and commit. |

## Out of scope

- The `exitCleanly`/`onFatalError` teardown duplication (F2) — refactor declined; fold it into a later natural touch of this file.
- The latent TDZ hardening (F1) — declined as a non-defect.
- The uncommitted working-tree edit to `src/dash/app.ts` (F3) — outside this epic's commit set.
