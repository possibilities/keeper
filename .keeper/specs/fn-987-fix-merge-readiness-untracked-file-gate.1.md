## Description

F1 (worktree-git.ts:457, `mergeReadiness`): the clean-tree probe is
`git status --porcelain`, whose output includes untracked `??` lines, so
ANY benign untracked file in the shared main checkout returns
`{ kind: "dirty" }`. The caller degrades that to a no-sticky skip-and-retry,
so finalize/recover silently never complete and the lane worktree +
base/rib branches accumulate — the pileup this surface exists to prevent.
Scope the clean check to tracked/staged/unmerged state (e.g.
`git status --porcelain --untracked-files=no`, or filter `??` lines out of
`detail` before deciding `dirty`), keeping the conservative block for real
WIP (staged/modified/unmerged) a merge could disturb. Off-branch and
non-fast-forward gates are unaffected.

Bundled finding F4 (Test Gap): add a `mergeReadiness` case proving an
untracked-only tree resolves `ready` — it is the direct proof of this fix
and folds into this same task/commit.

## Acceptance

- [ ] `mergeReadiness` returns `ready` for an untracked-only shared checkout
- [ ] `mergeReadiness` still returns `dirty` for staged/modified/unmerged state
- [ ] A `mergeReadiness` test asserts the untracked-only `ready` behavior (F4)

## Done summary

## Evidence
