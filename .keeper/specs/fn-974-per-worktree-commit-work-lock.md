## Overview

`keeper commit-work` holds an advisory `flock(LOCK_EX)` for the whole
stage->lint->commit->push window. Today the lock is keyed on
`git rev-parse --git-common-dir`, which returns the same `<repo>/.git` for the
main worktree AND every linked worktree — so all worktree-mode autopilot lanes
of a repo serialize through ONE global lock, and one lane's slow lint matrix
blocks every other lane's commit even though they touch disjoint, per-worktree
indexes. This epic keys the lock per-worktree instead: unchanged in the main
worktree, a distinct lock per linked worktree/lane. The only serialization that
genuinely matters — an autopilot base-merge vs. a `commit-work` in the SAME base
worktree, which truly share the base index — is preserved, because both resolve
to the base's own per-worktree git-dir.

## Quick commands

- `git -C <repo> rev-parse --path-format=absolute --git-dir` vs the same in a
  linked worktree — proves main resolves `<repo>/.git` while a lane resolves
  `<repo>/.git/worktrees/<name>` (distinct lock dirs).
- `bun run test:full` — the whole suite incl. the slow real-git worktree tests.
- `bun run test:hygiene` — the real-git allowlist gate must stay green.

## Acceptance

- [ ] The commit-work flock is keyed per-worktree at BOTH computing sites, with
  identical argv, so cross-lane serialization is gone but same-worktree
  (base-merge vs base-commit-work) serialization is preserved.
- [ ] Main worktree behavior is byte-identical; only linked worktrees move their
  lock under `<common>/worktrees/<name>/`.
- [ ] `bun run test:full` and `bun run test:hygiene` are green.

## Early proof point

The single task proves the approach end-to-end: the positive test asserting two
linked worktrees get DISTINCT locks while a base-merge and a base commit-work
share ONE lock. If it fails: the two sites are keying differently — re-confirm
both emit `rev-parse --path-format=absolute --git-dir` and join the same name.

## References

- Correctness basis (verified): git index / `index.lock` / HEAD / merge-state are
  per-worktree; only the object store, refs/`packed-refs`, and config are shared,
  and git already makes those concurrency-safe (content-addressed atomic-rename
  object writes; per-ref `<ref>.lock` that fails loud, never corrupts).
- In-repo precedent to mirror exactly: `src/commit-work/push.ts` and
  `src/worktree-git.ts` already shell `git rev-parse --path-format=absolute --git-dir`.
- Lanes already skip the push entirely (`src/commit-work/push.ts`,
  `skipped:"worktree"`), so the un-serialized path performs no remote writes; only
  the main worktree pushes, and it is unchanged.

## Docs gaps

- **README.md** (~line 1469, commit-work paragraph; ~lines 3185-3186, worktree-mode
  producer paragraph): replace the `$GIT_COMMON_DIR/keeper-commit-work.lock` key and
  the "shared" framing with the per-worktree path; state serialization as "same
  worktree," and drop the inaccurate "prune takes the lock" (prune does not acquire it).

## Best practices

- **Trust git's own concurrency primitives, not the external lock, for the shared
  store:** concurrent disjoint-branch commits/merges across worktrees are safe via
  per-ref atomic-rename locks + content-addressed loose objects — the flock only
  needs to cover the per-worktree index. [git-worktree(1), Gitaly #5160]
- **Prefer `--git-dir` over `--git-path <name>`:** `--git-path` routing for unknown
  filenames is an undocumented implementation detail; `--git-dir` is the documented,
  stable per-worktree path. [git-rev-parse(1)]
- **Known follow-up (OUT OF SCOPE):** un-serializing exposes a rare transient
  `cannot lock ref` / `packed-refs.lock: File exists` under concurrent `gc --auto`;
  the standard mitigation is bounded retry-with-backoff on the commit/merge ref-lock
  error, tracked separately. [Gerrit #416196171, Gitaly #5160]
