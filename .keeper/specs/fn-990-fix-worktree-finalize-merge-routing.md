## Overview

In worktree mode the close-sink finalize never fires: its merge guard reads
the LANE branch's epic-done state, but the closer writes `done` to the PRIMARY
repo (plan state always resolves to the primary repo, never the lane). So
`finalizeEpic` no-ops, and `recoverWorktrees` silently performs the lane→default
merge with no base teardown — leaking orphan base branches and worktrees after
every worktree epic. This epic makes finalize fire on the MAIN projection
done-state (plus a "lane carries real commits" check), consolidates finalize and
recover onto ONE guarded merge routine, adds an independent is-ancestor-gated
base teardown to the merge path, and hardens the push (admit a legitimate
first push; bound any hang). End state: a real worktree epic merges to the
default branch and tears its lane fully down with zero orphans — the
precondition for re-enabling worktree mode.

## Quick commands

- `KEEPER_PLAN_RUN_SLOW=1 bun run test:slow` — plan real-git slow tier (the lane cycle)
- `bun test test/autopilot-worker.test.ts test/worktree-git.test.ts` — fast driver tier

## Acceptance

- [ ] finalize fires on projection-done + lane-ahead and owns the lane→default merge + base teardown
- [ ] recover is a true backstop sharing finalize's guard + merge routine; no orphan base branch/worktree after a clean epic
- [ ] a never-pushed-default first finalize push is admitted, not deadlocked; no push can hang the cycle
- [ ] finalize-side degrade reasons stay OUTSIDE the worktree-recover* auto-clear scope

## Early proof point

Task that proves the approach: `.1` (finalize fires on projection-done via the
consolidated guarded routine). If it fails: the projection-done signal can't be
threaded into `finalizeEpic` cleanly → fall back to a dedicated finalizer step
that reads primary-side done directly.

## References

- A blind multi-model panel + direct source verification this session traced the done-state routing flaw: `finalizeEpic`'s lane-read guard (`gitEpicBaseHasDoneState`) vs the closer's primary-side done write; `recoverWorktrees` as the de-facto merge path with no base teardown; the push-precheck ordering deadlock on a never-pushed default.
- Builds on fn-988 (push robustness + cleanup), fn-985 (rib naming + finalize degrade), fn-984 (centralized worker-repo resolution). Supersedes fn-989 (its push-precheck + provenance items are absorbed into Task 3).
