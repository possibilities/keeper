## Description

**Size:** S
**Files:** src/autopilot-worker.ts, src/worktree-git.ts, test/autopilot-worker.test.ts, test/worktree-git.test.ts

### Approach

At lane provision time, after the worktree is ensured, create an idempotent directory
symlink lane/node_modules -> sourceCheckout/node_modules when the source has one and the
lane has none (skip silently otherwise; never replace a real directory; repair a broken or
stale symlink). Realpath resolution makes tsc/biome/bun behave identically through the
link (pnpm precedent); node_modules is gitignored so clean removeWorktree is unaffected.
Confirm the interaction with the husk sweep (isResidueOnlyDir vetoes on ANY symlink): the
bounded-teardown force path from the sibling task owns removing such lanes, and a comment
documents the shared-mutable-store tradeoff (same host, one platform).

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/autopilot-worker.ts:4726 — provision(); the insertion point after gitEnsureWorktree(:4740); repoDir is the source checkout
- src/worktree-git.ts:1510 — ensureWorktree idempotency/crash-recovery contract the symlink step must match
- src/worktree-git.ts:1835 — isResidueOnlyDir symlink veto (document the interaction; do not weaken the husk sweep)

**Optional** (reference as needed):
- test/worktree-git.test.ts FakeGitRule + fs-fake patterns for provision tests

### Risks

- A symlink pointing at a missing source node_modules would make Bun auto-install to its global cache (divergence) — skip when the source lacks node_modules.
- Never clobber a real node_modules directory a worker installed.

### Test notes

Provision cases: source has node_modules + lane bare → link created; re-provision → no-op;
lane has real dir → untouched; source lacks node_modules → skipped; broken link → repaired.

## Acceptance

- [ ] A fresh lane resolves its node_modules through a symlink to the source checkout when the source has one
- [ ] Provisioning is idempotent, never replaces a real directory, repairs a broken link, and skips when the source has no node_modules
- [ ] The husk-sweep interaction is documented and unweakened

## Done summary

## Evidence
