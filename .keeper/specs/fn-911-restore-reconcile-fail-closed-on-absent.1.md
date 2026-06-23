## Description

F1 (Should Fix). Evidence path: `plugins/plan/src/verbs/reconcile.ts:132-145`
(`findSourceCommits` returns `[]` when `vcs.isGitRepo(repo)` is false) and
`plugins/plan/src/vcs.ts:356-369` (`runReadGit` catches the `Bun.spawnSync`
ENOENT throw and returns `{exitCode: 1}`), so `isGitRepo` (vcs.ts:216-227,
`rev-parse --git-dir`) reads `false` on a host with no `git` binary and the
source scan collapses to a clean empty verdict. This violates the
fail-closed invariant in the reconcile module header
(`reconcile.ts:122-123`): ANY unexpected git failure must surface as
`tooling_error`, never a clean one.

The fix must distinguish "git present, not a work tree" (stays a clean `[]`)
from "git binary absent / spawn failed" (must fail-closed). Keep
`stateHeadVisible` behavior unchanged — it already throws when `isGitRepo`
is false. Land the regression test the audit named as a Test Gap.

## Acceptance

- [ ] Absent git binary on the source scan yields `tooling_error`, not a clean "no source commit" verdict.
- [ ] Git present but the directory is not a work tree still returns `[]`.
- [ ] A test drives the absent-binary path (via the fakeable vcs seam) and asserts `tooling_error` survives.

## Done summary
findSourceCommits now fail-closes on an absent git binary via a new gitBinaryPresent() facade probe (throws GitError), while git-present-but-not-a-work-tree still returns []. Added a regression test driving the absent-binary path through the fake vcs seam.
## Evidence
