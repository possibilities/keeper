## Description

**Size:** M
**Files:** plugins/plan/src/commit.ts, plugins/plan/src/emit.ts, plugins/plan/src/verbs/scaffold.ts, plugins/plan/src/verbs/epic_create.ts, plugins/plan/src/verbs/refine_apply.ts, plugins/plan/src/verbs/assign_cells.ts, plugins/plan/src/verbs/done.ts, plugins/plan/src/verbs/close_finalize.ts, docs/problem-codes.md, plugins/plan/test/src-commit.test.ts

### Approach

Wire the fast-fail and serialization contract across every mutating verb. At each
mutating verb's entry — before any plan-state write — probe the STATE repo (the
epic's primary_repo, never the lane cwd) via the facade's in-progress-op probe; on
a hit, emit a typed retryable `merge_in_progress` failure envelope naming the
detected operation and write nothing. Then acquire the commit-work lock (facade
path + sync deadline acquire from task .1) before the verb's first write and hold
it through the auto-commit in emitMutating, releasing on every exit path with
try/finally — the release must not rely on process exit, because close-finalize
runs scaffold in-process (runCaptured) and the bun test harness does too. Timeout
under contention emits a retryable envelope (never proceeds unlocked); an
environmental acquire failure degrades fail-soft to unlocked, matching
withEpicIdLock, with the probe still armed. Lock order is fixed: commit-work
outer, epic-id inner. In close-finalize, scaffoldFollowup currently maps every
non-zero scaffold outcome to terminal SCAFFOLD_FAILED — pass the retryable class
through instead so a close attempted mid-merge surfaces a re-runnable outcome
rather than a dead close. Revise docs/problem-codes.md in the same change: the
Plan-family preamble currently scopes the family to pre-commit validation; admit
the commit-time retryable class and add the `merge_in_progress` row (documenting
that it covers all in-progress-operation states, merge being the one keeper's own
machinery creates).

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/plan/src/commit.ts:29-321 — the retry loop, CommitFailed vocabulary (:58), and stderr classifiers (:143-150); `merge_in_progress` is a sibling typed outcome here, and the partial-commit stderr must never fall into the contention-retry arm
- plugins/plan/src/emit.ts:87-140 — emitMutating's commit-before-print ordering and process.exit(1) failure arm; the lock release seam wraps this
- plugins/plan/src/verbs/scaffold.ts:1004-1060 — the withEpicIdLock critical section and FlockOutcome sentinel pattern (never emit inside a lock; return a tagged union and emit outside) — the commit-work lock wrapping must follow the same pattern
- plugins/plan/src/verbs/close_finalize.ts:287,624-680 — scaffoldFollowup's terminal SCAFFOLD_FAILED mapping and the in-process runCaptured invocation
- docs/problem-codes.md — Plan family preamble and existing id_collision / duplicate_epic rows

**Optional** (reference as needed):
- plugins/plan/src/verbs/done.ts, assign_cells.ts, epic_create.ts, refine_apply.ts — the remaining mutating-verb entry points to guard
- plugins/plan/skills/close/SKILL.md — add the one-line poll-then-rerun beat for a merge_in_progress close outcome

### Risks

- Holding the commit-work lock across the epic-id flock inverts nothing today (no existing path takes both), but the order must be stated in code and tests so a future acquirer cannot deadlock
- The daemon's commit-work lock deadline is 45s; a plan verb waiting that long behind a lint-matrix commit-work run is retryable-correct but slow — pick a shorter plan-side deadline (a few seconds) since the caller retries anyway
- A verb invoked FROM a deconflict session holds MERGE_HEAD itself: the probe must fire before the lock acquire so the refusal is immediate and lock-free

### Test notes

Fast tier: fake-vcs arms each in-progress state per mutating verb → assert nothing
written, envelope shape, and no commit recorded; lock-timeout path via an
already-held tmpdir lock → retryable envelope; environmental path (unwritable lock
dir) → proceeds unlocked with a stderr note. Slow tier: real repo mid-merge →
scaffold fast-fails with nothing written; verify the real partial-commit stderr
still routes to merge_in_progress if it slips past a stale probe (EAFP arm).

## Acceptance

- [ ] Every mutating plan verb invoked while the state repo is mid merge/cherry-pick/revert/rebase writes no plan files, records no commit, and exits non-zero with a `merge_in_progress` envelope that names the operation
- [ ] The write→commit window of every mutating verb runs under the same lock file the daemon's merges and keeper commit-work use; lock timeout yields a retryable envelope, never an unlocked proceed
- [ ] A close-finalize whose follow-up scaffold hits the merge window surfaces a retryable outcome distinct from terminal scaffold failure, and a re-run after the window closes completes the close
- [ ] docs/problem-codes.md documents merge_in_progress as a commit-time retryable class with the Plan-family preamble revised accordingly
- [ ] In-process invocations (close-finalize, bun tests) never leak the lock across calls

## Done summary
Wired the merge-window guard + commit-work serialization across every mutating plan verb (scaffold, epic create, refine-apply, assign-cells, done): a lock-free in-progress probe refuses mid-operation before writing with a retryable merge_in_progress envelope, the shared commit-work flock is held across the write->commit window via try/finally (commit-work outer, epic-id inner), timeout is retryable and environmental degrades fail-soft. autoCommitFromInvocation classifies a stale-probe partial-commit refusal as merge_in_progress (EAFP), close-finalize passes the class through as re-runnable MERGE_IN_PROGRESS, and problem-codes.md registers the new commit-time retryable class.
## Evidence
