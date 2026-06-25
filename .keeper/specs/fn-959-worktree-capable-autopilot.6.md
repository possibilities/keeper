## Description

**Size:** S
**Files:** cli/commit-work.ts, src/commit-work/push.ts, test/commit-work*.test.ts

### Approach

Make `commit-work` GENERICALLY detect it is running inside a linked git
worktree and skip the push leg, returning a `skipped: worktree` envelope
instead of pushing. Decoupled from autopilot — any linked worktree, not just
autopilot's. Detection: compare `git rev-parse --git-dir` vs `--git-common-dir`
(`--path-format=absolute`); they differ in a linked worktree. Guard the
submodule false-positive with `git rev-parse --show-superproject-working-tree`
(non-empty → submodule, not a linked worktree → still push). The skip gate
goes at the `pushCommitted` call site; commit + lint + commit-and-lock legs are
unchanged.

### Investigation targets

**Required** (read before coding):
- cli/commit-work.ts:578-581 (pushCommitted call site — insert skip gate), :247-251 (gitCommonDir primitive already present), :519 (flock path).
- src/commit-work/push.ts:118-158 (pushCommitted + envelope shape), :82-84 (getCurrentBranch).
- src/commit-work/flock.ts:8 (documents --git-common-dir worktree semantics).

### Risks

- Submodule false-positive: `--git-dir != --git-common-dir` is ALSO true in a submodule — the `--show-superproject-working-tree` guard is mandatory or commit-work wrongly skips push in a legit submodule.
- Envelope contract: callers must treat `skipped: worktree` as success, not a push failure.

### Test notes

Unit tests via fake-git: main tree → pushes; linked worktree → skips with the skipped envelope; submodule → still pushes. A real-git variant belongs in `*.slow.test.ts` if added.

## Acceptance

- [ ] In a linked worktree, commit-work commits but skips push, returning a distinct `skipped: worktree` success envelope.
- [ ] Main-tree behavior unchanged; submodule checkouts still push (false-positive guarded).
- [ ] Detection is generic (not autopilot-coupled).

## Done summary
commit-work now generically detects a linked git worktree (git-dir != git-common-dir, submodule-guarded via --show-superproject-working-tree) and skips the push leg, returning a distinct skipped:worktree success envelope so per-lane branches never reach origin.
## Evidence
