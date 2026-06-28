## Overview

A pre-flight readiness panel for a worktree canary found two latent holes in the
worktree state-routing path — both NON-blocking for a correctly-shaped epic, but
worth closing before any real canary given worktree mode's failure history. (1) The
producer classifies an epic as worktree-`ok` without checking that `epic.primary_repo`
is set; a null/empty `primary_repo` makes the central plan-state resolver degrade to
the locate root, which from a lane cwd is the LANE — so `done`/`claim`/close state
would write to the lane branch, `isEpicDone` never flips, and `finalizeEpic` defers
forever (a silent worktree deadlock for a future mis-scaffolded epic). (2) In
`close-finalize`, mutations are correctly primary-rooted via `stateCtx`, but three
READS still use the cwd `ctx` (idempotency + followup-adoption checks) — neutralized
today because the close skill passes `--project`, but inconsistent with the sibling
`close-preflight` (which uses `stateCtx` for its read) and a latent mis-report if
finalize ever runs from a lane without `--project`. End state: a worktree epic with no
`primary_repo` is rejected LOUD before provisioning (never a silent lane-state
degrade); close-finalize reads and writes from the same primary-rooted context.

## Quick commands

- `cd plugins/plan && bun test` — plan plugin pure tier (finalize reads)
- `bun test test/autopilot-worker.test.ts` — producer guard (root tier, fake-runner)

## Acceptance

- [ ] a worktree-mode epic classified `ok` but with null/empty `epic.primary_repo` is rejected with a LOUD operator-required reason BEFORE any lane is provisioned (no silent degrade-to-lane)
- [ ] close-finalize's idempotency + followup-adoption READS use the same primary-rooted `stateCtx` as its writes (consistent with close-preflight)
- [ ] no regression to the existing worktree classify / finalize behavior; the gate stays green
- [ ] new reason (if any) is correctly scoped (a config/data reject is operator-required, OUTSIDE the worktree-recover auto-clear prefix)

## References

- From the fn-1000 worktree-canary readiness panel (NO-GO on fn-1000 itself because it
  is multi-repo). These two are its "minimal hardening" items: the null-`primary_repo`
  producer landmine (`autopilot-worker.ts` classify/dispatch ~1785/1943/2239 →
  `project.ts:240-242` degrade) and the close-finalize read asymmetry
  (`close_finalize.ts:450/482/537` use `ctx` vs `:445/529/540/567` use `stateCtx`;
  `close_preflight.ts:139` is the consistent sibling).
- CONSTRAINT: worktree-infra → runs with autopilot worktree mode OFF. Producer worktree
  lifecycle stays producer-only; re-fold determinism untouched (verb/producer-side).
