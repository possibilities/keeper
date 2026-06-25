## Description

**Size:** M
**Files:** cli/commit-work.ts, src/worktree-git.ts, src/commit-work/flock.ts, README.md, test/worktree-git.test.ts, test/commit-work.test.ts, test/commit-work-worktree-isolation.test.ts, test/worktree-git-realgit.slow.test.ts

### Approach

Move the `keeper commit-work` advisory flock from one-per-repo (keyed on
`git rev-parse --git-common-dir`, shared across all linked worktrees) to
one-per-worktree. The git index, `index.lock`, HEAD, and merge-state are
per-worktree, so two lanes committing concurrently share no mutable staging
state — the shared lock is over-broad. The one serialization that matters (an
autopilot base-merge vs. a `commit-work` in the SAME base worktree, which truly
share the base index) is preserved because both resolve to the base's own
per-worktree git-dir.

Key BOTH lock-computing sites IDENTICALLY via the documented-stable,
already-in-repo pattern:

    git rev-parse --path-format=absolute --git-dir   ->   join(gitDir, "keeper-commit-work.lock")

NOT `--git-path <name>` (its unknown-filename routing is undocumented). This
`--path-format=absolute --git-dir` form is already used by `src/commit-work/push.ts`
and `src/worktree-git.ts` — mirror it exactly. The two sites MUST emit the same
argv so a lane's commit-work lock and the autopilot merge lock for that same
worktree still collide; only cross-lane serialization is dropped. The main
worktree is unchanged there (`--git-dir == --git-common-dir`).

- **Site 1 — `cli/commit-work.ts`** (the lock build, ~line 545): replace the
  local `gitCommonDir` helper + the manual `if (!common.startsWith("/"))`
  abs-resolve with one `--path-format=absolute --git-dir` call. The helper's ONLY
  caller is this lock, so delete it (and the now-dead abs-resolve).
- **Site 2 — `commitWorkLockPath` in `src/worktree-git.ts`** (~line 211, consumed
  only by `mergeBranchInto` ~line 566): the same swap, using the module's local
  `joinPath` (no `node:path` in this file).

**Fallback (RESOLVED):** on `git` exit != 0 OR empty stdout, fall back to the
worktree-anchored absolute `join(cwd, ".git", "keeper-commit-work.lock")` — never
a bare relative `.git` (it would resolve against the daemon's ambient process cwd,
not the pinned worktree) and never `/keeper-commit-work.lock` (filesystem root,
from an empty stdout). Mirror the `res.code === 0 && out.length > 0 ? ... : ...`
guard shape that `resolveWorktreeRoot` in `cli/commit-work.ts` already uses.

**Rewrite every per-common-dir rationale** to per-worktree, present-tense, no
provenance (forward-facing docs rule): `src/commit-work/flock.ts` header, the
`cli/commit-work.ts` pipeline docstring + the inline lock comment, the
`src/worktree-git.ts` module header + `commitWorkLockPath` JSDoc + `mergeBranchInto`
JSDoc, and README.md. **Sanctioned serialization wording (RESOLVED):** "serializes
against a commit-work in the SAME worktree" — NOT "same repo" / "every lane" (the
change deliberately drops cross-worktree mutual exclusion). Also fix README's
"merge/prune takes the lock": `pruneWorktrees` does NOT acquire the lock — state
only the merge does.

**LINE NUMBERS DRIFT** — the commit-work surface has in-flight uncommitted edits,
so every line number in this spec is approximate. Grep the canonical strings
(`GIT_COMMON_DIR`, `git-common-dir`, `keeper-commit-work.lock`, `shared`) to locate
each site; do not trust the numbers.

### Investigation targets

**Required** (read before coding):
- `cli/commit-work.ts` ~248-251 (`gitCommonDir` helper — delete) and ~542-549 (lock
  build + abs-resolve to replace).
- `src/worktree-git.ts` ~211-218 (`commitWorkLockPath` to swap) and ~551-591
  (`mergeBranchInto`, its only caller; lock acquired ~566).
- `src/commit-work/push.ts` ~150 — the EXISTING `["rev-parse","--path-format=absolute","--git-dir"]`
  precedent to mirror exactly. DO NOT change this file.
- `src/worktree-git.ts` ~619-631 — the local `joinPath`/`stripTrailingSlash` helpers.
- `test/helpers/fake-git.ts` — `fakeAsyncGit(rules)` + `argvStartsWith`; fake the
  swap as `argvStartsWith(a, "rev-parse", "--path-format=absolute", "--git-dir")`.

**Optional** (reference as needed):
- `cli/commit-work.ts` ~487 `resolveWorktreeRoot` — the `code===0 && len>0 ? x : fallback`
  guard shape to mirror for the lock fallback.
- `src/doc-commit.ts` ~119 — a SEPARATE `--git-path` surface (MERGE_HEAD probe). DO
  NOT touch it or its tests (`test/docs-pusher.test.ts`, `test/doc-commit.test.ts`).

### Risks

- Both sites must key IDENTICALLY — divergent argv silently breaks the preserved
  base-merge <-> base-commit-work serialization. Pin it with the positive test below.
- The fake rules at `test/commit-work.test.ts` ~71 and
  `test/commit-work-worktree-isolation.test.ts` ~111-114 must be UPDATED to the new
  argv, not deleted — a dropped rule falls through to `fakeAsyncGit`'s exit-0/empty
  default and silently yields the degenerate `/keeper-commit-work.lock`.
- New rare/transient surface: the lock now lives inside the per-worktree git-dir,
  which `git worktree remove`/`prune` deletes. The producer only removes clean/merged
  lanes, so a live commit-work racing its own teardown is low-probability; the broader
  transient ref-lock retry hardening is a KNOWN SEPARATE FOLLOW-UP, out of scope.

### Test notes

- Flip every test faking `--git-common-dir` or asserting the shared lock (grep to
  re-confirm sites — numbers drift): `test/worktree-git.test.ts` (the two
  `commitWorkLockPath` unit tests incl. the non-repo fallback ~270-292, and the two
  `mergeBranchInto` tests' lock fakes ~559-561 + asserts ~571/608);
  `test/commit-work.test.ts` ~71; `test/commit-work-worktree-isolation.test.ts` ~111-114.
- `test/worktree-git-realgit.slow.test.ts` INVERTS: the base-vs-lane lock equality
  (~237-239) becomes `.not.toBe`, and its section header / title / in-test comment
  (~224/227/238) + the downstream `acquired === <base lock>` assertion must point at
  baseWt's per-worktree git-dir.
- Update the non-repo fallback expectation to the worktree-anchored absolute path.
- Add a POSITIVE test: two distinct linked worktrees resolve to DISTINCT lock paths,
  while a base-merge and a base commit-work resolve to the SAME path.
- `bun run test:full` is mandatory (git process paths + slow real-git files);
  `bun run test:hygiene` must stay green. Both slow real-git files are already
  allowlisted — no allowlist edit unless a NEW real-git file is added.

## Acceptance

- [ ] Both lock sites (`cli/commit-work.ts`, `commitWorkLockPath` in `src/worktree-git.ts`)
  compute the path from `git rev-parse --path-format=absolute --git-dir` + join, with identical argv.
- [ ] Main worktree lock path is unchanged (`<repo>/.git/keeper-commit-work.lock`); a linked
  worktree resolves to `<repo>/.git/worktrees/<name>/keeper-commit-work.lock`.
- [ ] Git-failure / empty-stdout fallback yields the worktree-anchored absolute
  `<cwd>/.git/keeper-commit-work.lock` — never relative, never `/keeper-commit-work.lock`.
- [ ] The local `gitCommonDir` helper and the manual abs-resolve in `cli/commit-work.ts` are deleted.
- [ ] All per-common-dir rationale (flock.ts, commit-work.ts, worktree-git.ts comments/docstrings,
  README) rewritten to per-worktree, present-tense; serialization described as "same worktree," and
  the README "prune takes the lock" inaccuracy corrected.
- [ ] A positive test asserts two linked worktrees get DISTINCT locks while base-merge and
  base-commit-work share ONE; the real-git slow test's shared-lock assertion is inverted.
- [ ] `bun run test:full` and `bun run test:hygiene` are both green.
- [ ] `src/doc-commit.ts` and its tests are untouched.

## Done summary
Keyed the commit-work advisory flock per-worktree via 'git rev-parse --path-format=absolute --git-dir' at both lock sites (cli/commit-work.ts + commitWorkLockPath), so disjoint linked worktrees take distinct locks while a base-merge and a commit-work in the same worktree still serialize. Main worktree path unchanged; full + hygiene + slow real-git suites green.
## Evidence
