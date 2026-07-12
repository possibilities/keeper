## Description

**Size:** M
**Files:** cli/commit-work.ts, test/commit-work.test.ts

### Approach

Two coupled behavioral changes to `keeper commit-work`'s in-lock flow, which today stages
`git add -A -- <attributedFiles>`, computes `allStaged` via `git diff --cached --name-only -z
--diff-filter=ACMRD`, SILENTLY unstages `stale = allStaged - attributedFiles` via
`git reset HEAD -- <stale>`, lints, then commits the WHOLE index with `git commit -F -`.

1. **Index-purity gate (default fail-loud).** Replace the silent stale unstage: when `stale`
is non-empty, emit a compact failure envelope `{success:false, error:"stale_index_carryover",
count, sample, hint, recovery}` and exit 1. `sample` lists the offending staged-but-unattributed
paths, sorted, capped at 20, with `count` carrying the total — the operator must be able to
choose a recovery without running another git command. The recovery text names BOTH paths:
re-run with `--allow-stale-unstage` to unstage the extras and commit attributed-only
(yesterday's silent behavior, now explicit), or commit the mixed set with plain git and
explicit paths (`git add <path> ... && git commit`). New boolean flag `--allow-stale-unstage`
mirrors `--preview-files` in `parseArgs`/`ParsedArgs`/HELP/AGENT_HELP. WHY fail-loud: the
attributed set derives ONLY from Write/Edit-class PostToolUse hooks (see `src/derivers.ts`
mutation_path derivation), so `git apply`, codegen, and script-written files are invisible to
it — today those silently DROP from commits (under-staging with live specimens), and a
desynced checkout shows up as exactly this stale set. Both must be loud. Do NOT bake the
override into any worker-facing guidance.

2. **Pathspec-limited commit.** Change the commit invocation from `git commit -F -` (whole
index) to `git commit -F - -- <pathspec>` with env `GIT_LITERAL_PATHSPECS=1`, where the
pathspec is the post-gate staged set (`allStaged` intersected with attributed files). Git's
`--only` mode builds the commit tree from HEAD plus the worktree content of ONLY the named
paths — staged entries outside the pathspec are physically held back, so a poisoned index
cannot leak into the tree even when the gate is overridden. The pathspec must be
RENAME-COMPLETE: derive both `allStaged` and the pathspec with `--no-renames` so a rename
splits into its A and D halves (with rename detection, `--name-only` reports only the new
path, and committing half a rename leaves a broken tree). Deletions must ride the pathspec:
build it from the staged-name set, never from the lint list (which filters to files that
still exist on disk). Never commit one half of a rename pair: if either half lands in the
stale set, the gate fires (all-or-nothing).

Edge handling, all as structured envelopes (never crashes), all following the in-lock
emission discipline — `printCompact(...)` then `return 1` with the flock released by the
outer `finally`, mirroring the existing `lint_failed` path; never the throwing `fail()`
helper inside the lock:
- Empty resolved pathspec (nothing attributed is staged): distinct `nothing_to_commit`
  envelope; skip commit and push.
- `git commit` non-zero on pathspec-no-match or "nothing to commit": commit-failure envelope
  preserving git's stderr.
- Mid-merge: git HARD-refuses a partial commit ("cannot do a partial commit during a merge");
  surface that refusal as a commit-failure envelope. A proactive in-progress gate is a
  separate dependent task — do not build it here.

### Investigation targets

*Verify before relying — cited by file + symbol; the repo moves, so re-locate with search.*

**Required (read before coding):**
- cli/commit-work.ts — `runInner` in-lock flow: `gitStage`, `stagedFileNames`, the
  stale-carryover reset block, `gitCommitStaged`, `printCompact`/`pyCompact`, `parseArgs` +
  `ParsedArgs` + `HELP`/`AGENT_HELP`, and the `file_list_too_large` + `lint_failed` envelopes
  (the richness/emission templates).
- test/commit-work.test.ts — `runForTest` + the `deps(...)` builder + `fakeAsyncGit` rule
  style; every new behavior is asserted through this seam.
- test/helpers/fake-git.ts — ordered argv-predicate rules; calls record argv/stdin/cwd/env
  (assert `GIT_LITERAL_PATHSPECS=1` via the recorded env).

**Optional:**
- src/commit-work/git-exec.ts — the injected `GitRunner` seam and env construction.
- src/commit-work/attribution.ts — `discoverSessionFiles` (why the attributed set is what it is).
- src/derivers.ts — mutation_path derivation (the under-attribution mechanism).

### Risks

- `--only` commits WORKTREE content of the named paths, not the staged blob; inside the flock
  commit-work stages immediately before committing, so index==worktree for named paths — do
  not introduce any step between stage and commit that could reopen that window.
- The escape-hatch wording in HELP/AGENT_HELP is finalized end-to-end by the dependent
  repo-state-gates task; keep this task's wording consistent with the envelope recovery text.

### Test notes

Fake-git seam only, no real git. Cover: gate fires with the bounded sorted sample and both
recovery paths; `--allow-stale-unstage` restores the reset argv; commit argv carries the exact
rename-complete pathspec after `--` plus the literal-pathspecs env; deletions appear in the
pathspec; a rename with one stale half fires the gate; empty pathspec yields
`nothing_to_commit` and no commit/push calls; git commit non-zero maps to the failure
envelope; every failure path releases the flock (assert via the injected lock's release
recording).

## Acceptance

- [ ] `keeper commit-work` with staged paths outside the attributed set fails by default with
  a `stale_index_carryover` envelope naming the offending paths (sorted sample capped at 20
  plus total count) and a recovery contract naming both paths forward; `--allow-stale-unstage`
  restores the previous unstage-and-proceed behavior explicitly.
- [ ] The commit invocation is pathspec-limited to the attributed staged set with pathspec
  magic disabled; content staged outside that set cannot appear in the commit tree even when
  the gate is overridden.
- [ ] Rename pairs never half-commit: set derivation splits renames into both halves, and a
  stale half triggers the gate rather than a partial commit; deletions ride the pathspec.
- [ ] An empty resolved commit set and git's own partial-commit/no-match refusals surface as
  structured envelopes, not crashes; the flock is released on every failure path.
- [ ] HELP and AGENT_HELP document the gate, the flag, and both recovery paths; the fast
  suite is green with no real git spawned.

## Done summary

## Evidence
