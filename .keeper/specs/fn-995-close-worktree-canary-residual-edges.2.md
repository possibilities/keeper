## Description

**Size:** S
**Files:** src/worktree-git.ts, test/worktree-git.test.ts

### Approach

B2 (local-timeout leaves MERGE_HEAD). `mergeBranchInto`'s local-timeout path
(src/worktree-git.ts ~:861-862) returns `local-timeout` from the SIGKILL-124
sentinel BEFORE reaching the MERGE_HEAD-guarded `git merge --abort`, so a killed
merge can leave `MERGE_HEAD`/partial state. Run a MERGE_HEAD-guarded
`git merge --abort` before returning `local-timeout`, so no residue is left for
the next cycle (closes the narrow clean-tree-plus-MERGE_HEAD → spurious-conflict
edge). The common case already self-heals (next cycle's `mergeReadiness` sees a
dirty tree and defers), so this is belt-and-suspenders.

B4 (unbounded merge-path reads). `mergeReadiness`'s `status --porcelain`
(~:515), `wouldClobberUntracked`'s `ls-files` / `ls-tree` (~:545/:560), and
`currentBranch`'s `rev-parse` carry no `timeoutMs`. None run hooks (so the
blocking-hook freeze is out of reach), but an fsmonitor/FS stall could wedge the
cycle. Pass `GIT_LOCAL_TIMEOUT_MS` (the existing local bound) to these reads;
a timed-out read degrades SAFELY — never a false clean/dirty — to a not-ready /
retry-skip.

### Investigation targets

**Required** (read before coding):
- src/worktree-git.ts mergeBranchInto local-timeout path (~:861-862), the MERGE_HEAD-guarded abort, the 124 sentinel
- src/worktree-git.ts:515 (mergeReadiness status), :545/:560 (wouldClobberUntracked ls-files/ls-tree), currentBranch rev-parse
- src/commit-work/git-exec.ts (GIT_LOCAL_TIMEOUT_MS, the 124 timeout sentinel + handling)

### Risks

- A timed-out READ must degrade to a SAFE not-ready/retry-skip — never misclassify as clean (which could let a would-clobber merge through) or as a false conflict.
- Keep the local-timeout → retry-skip classification intact; the added abort must not change the returned MergeResult kind.

### Test notes

Pure fake-runner: a local-timeout merge → a MERGE_HEAD-guarded `git merge --abort` is issued, kind still `local-timeout`; a timed-out read (124) → a safe not-ready/retry-skip, not a false result.

## Acceptance

- [ ] the local-timeout merge path runs a MERGE_HEAD-guarded `git merge --abort` so no merge residue is left
- [ ] the merge-path read ops (status / ls-files / ls-tree / rev-parse) carry a local timeout and degrade safely on timeout
- [ ] no regression to the existing local-op timeout / conflict classification

## Done summary

## Evidence
