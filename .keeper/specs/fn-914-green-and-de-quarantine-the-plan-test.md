## Overview

fn-904 made both test suites fast (keeper-root 147s→31s green; plan suite
16.9s in-process, no build) but left the plan-plugin `bun test` red and
surfaced a pile of never-run quarantined tests. Two cleanups: (1) fix the 9
failures — they are `planctl→keeper` rename stragglers inherited from fn-889
(a verb-extraction grep and a hardcoded `.planctl/` path), NOT fn-904's
de-gitting; (2) resolve the ~89 plan tests gated behind `SLOW_ENABLED`
(`KEEPER_PLAN_RUN_SLOW`) and `PROCESS_ENABLED` (`KEEPER_PLAN_RUN_PROCESS`) —
no script or CI sets either env, so they run nowhere. End state: the plan
`bun test` is fully green with zero never-run skipped tests, and keeper-root
+ plan typecheck + lint stay clean.

## Quick commands

- `cd plugins/plan && bun test --timeout 30000` — must report 0 fail, 0 error
- `cd plugins/plan && bun run typecheck && bun run lint` — both clean
- `bun run typecheck && bun run lint` (repo root) — both clean
- `grep -rnE 'skipIf\(!(SLOW|PROCESS)_ENABLED\)' plugins/plan/test` — every remaining gate is reachable by a wired runner, or the gate is gone

## Acceptance

- [ ] `cd plugins/plan && bun test` reports 0 fail and 0 error
- [ ] Keeper-root and plan-plugin `typecheck` + `lint` both pass (they pass today — keep them green)
- [ ] No plan test is gated behind an env no command ever sets: each `SLOW_ENABLED`/`PROCESS_ENABLED` test is either deleted (redundant with the in-process/synthetic coverage) or reachable via a wired `test:slow`/`test:process` script
- [ ] The keeper-root `.slow.test.ts` quarantine is confirmed reachable via `test:full` (it is) and documented as the full-tier-only real-git set

## Early proof point

Task that proves the approach: the rename-straggler fix (task .1) — it turns
the plan suite green and is a self-contained mechanical change. If it
surfaces deeper rename rot, that scopes how much task .2 must also touch.

## References

- Caused by fn-889 (`planctl→keeper` rename), surfaced by fn-904 (plan suite now runs in-process without a build). Both are closed/done — no open dependency.
- The quarantine gates (`SLOW_ENABLED`/`PROCESS_ENABLED`) live in `plugins/plan/test/harness.ts`; fn-904 added the `PROCESS_ENABLED` bucket, `SLOW_ENABLED` predates it.
- fn-904's no-real-git convention + `scripts/lint-no-real-git.ts` (`bun run test:hygiene`) — deletions must not reintroduce real git into a non-allowlisted file.
