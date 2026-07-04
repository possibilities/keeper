## Description

**Size:** M
**Files:** src/autopilot-worker.ts, test/autopilot-worker.test.ts

### Approach

Consume the new classification in the producer passes. Extend the recover
pass to probe the shared MAIN checkout (today pass-1 filters to keeper lane
entries only, so the primary repo's wedge is invisible): a keeper-owned
mid-merge there gets the bounded MERGE_HEAD-guarded abort — under the
commit-work flock, honoring the live-resolver exclusion and the per-epic
resolver/merge-worker exclusions, only while the board is playing — and the
next cycle re-derives a clean merge; foreign/ambiguous residue is never
aborted and defers with a reason that names what was found. Thread the
mid-merge readiness kind through the shared lane-merge routine and BOTH
consuming switches so recover and finalize each mint a distinct
`worktree-recover-mid-merge` / `worktree-finalize-mid-merge` reason carrying
the MERGE_HEAD ref and ownership verdict — the incident's core failure was
this reason degrading to "dirty-checkout". Both new reasons stay inside
their existing prefixes so the recover-scoped level-clear keeps applying.
A failed abort (task 1's new result arm) mints its own recover reason.
Reproduce the incident in the stateful recovery fake: main checkout
mid-merge on a keeper lane → abort → merge proceeds next cycle; foreign →
defer + named reason; abort failure → named reason.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/autopilot-worker.ts:3002-3128 — recoverWorktrees pass-1; the isKeeperLaneEntry filter at :3097 that excludes the main checkout; hasActiveResolver exclusion at :3107; abort+prune shape at :3110-3119
- src/autopilot-worker.ts:2885-3000 — mergeLaneBaseIntoDefault; readiness consumption at :2932-2941 where the mid-merge kind must be handled
- src/autopilot-worker.ts:3178-3290 — the recover switch minting worktree-recover-* reasons (dirty-checkout :3192, conflict :3220, exhaustiveness tail :3270)
- src/autopilot-worker.ts:2451-2714 — finalizeEpic's twin switch (:2571-2628); mirror the recover threading
- src/daemon.ts:1362, 1419-1449 — the per-epic recover exclusion while a resolve::<epic> worker is live; the main-checkout abort must honor the same gate

**Optional** (reference as needed):
- test/autopilot-worker.test.ts:8102-8281 — makeRecoveryGit stateful fake; extend its state with a main-checkout mid-merge scenario
- test/autopilot-worker.test.ts:8338-8495 — recover-pass tests driving recoverWorktrees; the incident reproduction belongs here
- src/autopilot-worker.ts:475 — recoverFailuresToClear, the prefix-scoped level-clear the new reasons must stay inside

### Risks

- Aborting in the shared main checkout races a concurrent agent commit — the commit-work flock acquisition is mandatory, and a lock timeout degrades to defer, never a blind abort
- The reason-string vocabulary is asserted inline across suites (toContain) — grep worktree-recover-/-finalize- assertions and keep them green

### Test notes

All through the pure seams: makeRecoveryGit gains mergeHead/branch-at-sha/
autostash state; assert the abort argv is issued only in the keeper-owned
scenario, never for foreign/ambiguous/autostash/paused/resolver-live, and
that minted reasons carry the MERGE_HEAD ref and ownership verdict.

## Acceptance

- [ ] A keeper-owned mid-merge in the shared main checkout is aborted exactly once, under the flock, only while playing, honoring resolver exclusions, and the following cycle's merge proceeds from a clean tree
- [ ] Foreign or ambiguous mid-merge residue is never aborted; its recover/finalize reason names the in-progress operation, MERGE_HEAD ref, and ownership verdict instead of reading dirty-checkout
- [ ] Recover and finalize each mint their own distinct mid-merge reason inside their existing prefix families, and the recover-scoped level-clear still clears them when the tree recovers
- [ ] A failed abort surfaces as its own named recover reason
- [ ] The incident scenario is reproduced in the recover-pass suite and passes; the full fast tier stays green with no real git

## Done summary
recoverWorktrees pass-1 self-heals a keeper-owned mid-merge in the shared main checkout via a flock-guarded, resolver-excluded abort; mergeLaneBaseIntoDefault + both recover/finalize switches mint distinct worktree-{recover,finalize}-{mid-merge,abort-failed} reasons instead of degrading to dirty-checkout.
## Evidence
