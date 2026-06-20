## Overview

Closes test-coverage and error-propagation debt left by the
fn-608 readiness-client extraction. Two scoped touchups: propagate
terminal `error` frames out of `subscribeReadiness` so callers can choose
their own exit policy (and the pre-extraction `process.exit(1)` behavior
is restored as the default), and add the lifecycle / filter tests that
the audit flagged as missing for the new `src/readiness-client.ts` helper
and `scripts/autopilot.ts`'s block-2 renderer.

## Acceptance

- [ ] `subscribeReadiness` propagates terminal error frames via an
  optional `onFatal` callback; default behavior matches the pre-extraction
  `process.exit(1)`.
- [ ] A new `test/readiness-client.test.ts` covers first-paint gate,
  coalesce, idempotent dispose, and the terminal-error path.
- [ ] A new `test/autopilot.test.ts` covers `renderEpicCommandsFiltered`'s
  all-pass, some-pass, and none-pass-returns-null cases.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | culled | — | Auditor flagged sibling renderers as advisory; doc justifies the pattern and there is no user-visible impact. |
| F2 | culled | — | Auditor explicit "practically fine for short-lived CLI"; no realistic FD-leak failure scenario. |
| F3 | culled | — | Docstring already documents the empty-set `===` body as intentional; cosmetic only. |
| F4 | culled | — | Pure code-comment suggestion; no user impact and the invariant holds today. |
| F5 | culled | — | Housekeeping commit-message clarity only; the biome fixes will ride in any follow-up commit. |
| F6 | culled | — | Already resolved out-of-epic in commit 44bef87; no residual work. |
| F7 | kept   | .1 | Real behavior change — pre-refactor `scripts/board.ts:870` (commit 212be34^) called `process.exit(1)` on a terminal error frame; extraction dropped that exit and no caller `emitLifecycle` reinstates it. Localized fix in `src/readiness-client.ts`. |
| F8 | kept   | .1 | Bundled with F7 because the lifecycle test naturally exercises the new onFatal contract, and both touch `src/readiness-client.ts` — single commit. |
| F9 | kept   | .2 | New `isReady` predicate and `renderEpicCommandsFiltered` null-return path in `scripts/autopilot.ts` have zero coverage; pure-function-testable, separate file from F7/F8. |

## Out of scope

- Refactoring `renderEpicCommands` / `renderEpicCommandsFiltered` into shared private helpers (F1 — advisory, not done).
- Docstring tweak for `dispose()` FD-cleanup race (F2 — culled).
- Empty-set `renderBody` semantics change (F3 — culled; doc-intentional).
- Comment on `lastEpicsSnapshot` ordering invariant (F4 — culled).
- Staging the unstaged biome fixes to `src/git-worker.ts` and `test/subagent-invocations.test.ts` (F5 — housekeeping; will land naturally in any follow-up commit).
