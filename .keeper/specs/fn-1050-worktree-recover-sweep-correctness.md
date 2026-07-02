## Overview

The recover sweep treats linked-worktree lanes as standalone repos (they register as git-projection roots, and `--show-toplevel` inside a lane returns the lane), so pass-2 fails `off-branch` by construction and mints misleading recover rows; the per-epic recover row key then lets last-writer-wins masking hide the actionable reason (live incident: a lane's `not-on-default` noise masked the main checkout's `dirty-checkout`). This epic filters lanes out of the sweep, rekeys recover rows per-(epic,repo) the way finalize rows already are, makes the not-on-default reason name its remedy, and teaches teardown to remove residue-only husk dirs.

## Quick commands

- `bun test test/autopilot-worker.test.ts test/worktree-git.test.ts` — the recover + teardown coverage
- `keeper query dispatch_failures` — post-deploy, stale old-scheme recover rows should level-clear within one cycle

## Acceptance

- [ ] A linked-worktree lane is never swept as a repo; a probe error defers that repo for the cycle (never fail-open into the off-branch path)
- [ ] Concurrent recover failures across a main checkout and its lanes (or across multi-repo dirs) mint DISTINCT rows; no reason masking
- [ ] Persisted old-scheme recover rows self-heal (level-clear) on the first post-fix cycle; a genuine finalizeEpic close-sink conflict row is untouched
- [ ] Teardown leaves no husk dir when only `.claude` residue remains, and leaves the dir fully intact when anything else is present

## Early proof point

Task that proves the approach: `.1` — a sweep-set test with a lane in the git projection goes red on current source (lane swept, off-branch row minted) and green with the filter. If it fails: the filter can fall back to the knownRoots snapshot build with a memoized porcelain probe.

## References

- Live incident: `close::fn-7-mac-hardening-toolset` (dotfiles repo) — four sweeps (main + 3 lanes) shared one row key; lane `not-on-default` reason masked the main checkout's `dirty-checkout`
- Finalize per-repo key pattern: `worktreeFinalizeDispatchId` (src/autopilot-worker.ts:668) + its test family (test/autopilot-worker.test.ts:5492,5531,5553,5607)
- House probe rule (CLAUDE.md worktree paragraph): every probe inconclusive/error DEFERS

## Docs gaps

- **README.md** (~3559-3584): recover sweep membership — linked worktrees excluded via `isLinkedWorktree`, not merely branch-prefix filtering
- **README.md** (~3566-3574): new recover key shape + the masking rationale, using the finalize keying prose (~3514-3520) as the template
- **README.md** (~3557-3578): teardown husk-dir sentence
- **CLAUDE.md** (worktree paragraph): one-clause precision update of the recover-row key shape — no expansion

## Best practices

- **Linked-worktree detection compares `--git-dir` vs `--git-common-dir`** (never `--show-toplevel` — the core bug); the in-repo `isLinkedWorktree` already does this
- **`git worktree prune` is metadata-only and idempotent** — safe after any dir removal; never run git worktree commands from inside the worktree being removed
- **Residue deletion is content-gated:** lstat-walk (never stat), veto ALL symlinks, `path.resolve` containment; abort untouched on any non-allowlisted entry
