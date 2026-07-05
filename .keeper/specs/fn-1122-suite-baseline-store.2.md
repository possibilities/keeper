## Description

**Size:** S
**Files:** src/worktree-git.ts, test/worktree-git.test.ts

### Approach

A sibling to ensureWorktree for the baseline runner's needs: create a
detached checkout at an arbitrary commit sha (`git worktree add --detach`)
under the out-of-repo worktrees root, using a scratch path prefix that can
never collide with `keeper/epic/*` lanes; verify the checkout is clean at
exactly the requested sha before reporting ready (a dirty scratch tree
must never produce a result under a clean key); and remove/prune helpers
that identify scratch worktrees by their prefix so boot can reap orphans.
An unresolvable sha returns a typed failure (feeds the infra-error:
checkout envelope), never a throw. All git goes through the module's
existing GitRunner/gitExec seam so decisions stay testable without
executing git.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/worktree-git.ts:1047 — ensureWorktree: the branch-creating sibling whose shape (runner seam, error style) this helper mirrors
- src/worktree-git.ts:476-540 — listWorktrees + pruneWorktrees: the orphan-cleanup idioms boot reap composes with
- src/worktree-plan.ts:174-220 — worktreePathFor + repoDirHash: the path scheme; derive the scratch prefix here so lanes and scratch never collide

**Optional** (reference as needed):
- src/worktree-git.ts:1282-1340 — removeWorktree + pruneWorktreeHusk: removal semantics to reuse
- test/worktree-git.test.ts — the pure-seam test idiom (decisions through GitRunner fakes, never real git)

### Risks

- A scratch path that pattern-matches a lane path could be swept or merged by the autopilot recover pass — the prefix must be structurally distinct and the recover pass must ignore it (verify by reading how the recover pass enumerates lanes).
- Shallow or unfetched history makes a sha unresolvable — that is a typed checkout failure, not a retry loop.

### Test notes

Pure seam only: assert the git argv sequences (add --detach, verify
HEAD==sha, status cleanliness probe, remove, prune) and the
typed-failure paths through GitRunner fakes. No real git in tests.

## Acceptance

- [ ] The helper creates a detached checkout at a requested sha under an out-of-repo scratch path whose prefix cannot collide with epic lane paths, and reports ready only after verifying HEAD equals the sha and the tree is clean
- [ ] An unresolvable sha yields a typed checkout failure; remove and boot-prune helpers identify scratch worktrees by prefix and are idempotent
- [ ] All new behavior is asserted through the pure git-runner seam; the suite is green via the sanctioned fast gate

## Done summary
Added baseline scratch-worktree helpers to src/worktree-git.ts: baselineScratchPathFor (collision-proof detached prefix), provisionScratchWorktree (detached checkout verified HEAD==sha + clean, typed checkout-failed never a throw, reaps on every path), removeScratchWorktree (prefix-gated --force), and pruneBaselineScratchWorktrees (boot orphan reap). Covered pure-seam through the GitRunner fake.
## Evidence
