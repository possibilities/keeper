## Description

**Size:** M
**Files:** plugins/plan/src/commit.ts, plugins/plan/src/emit.ts, plugins/plan/src/vcs.ts, plugins/plan/src/verbs/scaffold.ts, plugins/plan/src/verbs/epic_create.ts, plugins/plan/src/verbs/refine_apply.ts, plugins/plan/src/verbs/assign_cells.ts, plugins/plan/test/fake-vcs.ts, plugins/plan/test/src-commit.test.ts

### Approach

Make every mutating verb a working-tree no-op on any commit failure. The facade
gains `restorePathspec(files, cwd)`: unstage the verb's own pathspec (`git reset
HEAD -- <files>` works mid-merge), unlink files that did not exist before the verb
ran, and restore previously-existing files from HEAD. Each mutating verb registers
the existing onCommitFailure hook in emitMutating with its exact written-path set —
the `done` verb already does snapshot-then-restore and is the shape to generalize;
scaffold's writtenPaths list is currently scoped inside its flock section and must
be hoisted to reach the hook. A rollback that itself fails must not mask the
authoritative commit_failed envelope (the hook's throw is swallowed by design), but
it must not be silent either: stamp `rollback_failed: true` plus the failing paths
into the failure envelope details and write one stderr line, so a reopened
destruction window is visible. Coordinate with fn-1190.1 (in flight on this exact
seam for `done`): whoever lands second merges the contracts — the generic pathspec
rollback must subsume, not regress, its unstage fix.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/plan/src/verbs/done.ts:283-305 — the snapshot-bytes-then-restore precedent (atomicWriteRaw back, unlinkSync fresh) this task generalizes
- plugins/plan/src/emit.ts:100-120 — the onCommitFailure seam and its swallowed-throw discipline
- plugins/plan/src/verbs/scaffold.ts:1233-1284 — writtenPaths scope (inside the flock) vs emitMutating call site (outside); the hoist
- plugins/plan/test/fake-vcs.ts — models `.keeper/` as snapshot diffs and `git add` as a no-op today; needs restore + staged-state modeling for these tests to mean anything
- The landed state of fn-1190.1's commit.ts/done.ts changes at implementation time — merge contracts, don't collide

**Optional** (reference as needed):
- plugins/plan/src/commit.ts:120 — gitCommit's pathspec commit; the failure classes that reach the hook
- plugins/plan/src/verbs/refine_apply.ts:689-780 — refine-apply's write set and existing integrity-gate unwind (runs before commit; distinct from this hook)

### Risks

- Restore-from-HEAD for modified files must use the pre-verb content, and HEAD may have advanced between write and rollback under contention — restoring the snapshot bytes (done.ts's approach) is safer than `git checkout HEAD --` where a snapshot exists
- The fake VCS has no real index; over-faithful modeling is a tar pit — model exactly what the tests assert (written set, staged set, restore effect) and no more
- An epic_create/scaffold rollback deletes freshly minted files whose number the ledger already burned — correct by design (gaps are accepted), but tests must assert the next mint gets a NEW number, not the rolled-back one

### Test notes

Fast tier: per mutating verb — arm failNextCommit, assert post-failure tree equals
pre-verb tree (no staged residue, no orphan files, modified files restored) and the
envelope carries commit_failed; arm a rollback failure and assert rollback_failed
rides the envelope without masking commit_failed. Slow tier: real repo, real
mid-merge partial-commit refusal → rollback leaves `git status --porcelain` empty
for the verb's pathspec while the foreign merge state is untouched.

## Acceptance

- [ ] After any auto-commit failure, the working tree and index contain no trace of the failed verb's writes — fresh files gone, modified files at pre-verb content, nothing of the verb's staged — while unrelated files and any in-progress merge state are untouched
- [ ] A rollback that itself fails surfaces `rollback_failed` detail in the failure envelope without replacing the commit failure as the primary error
- [ ] The `done` verb's durable-or-nothing behavior (fn-1190) still holds under the generalized rollback
- [ ] Fast-tier tests cover every mutating verb's rollback with zero real git; the real-git rollback runs in the slow tier

## Done summary

## Evidence
