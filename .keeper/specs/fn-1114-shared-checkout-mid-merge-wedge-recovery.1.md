## Description

**Size:** M
**Files:** src/worktree-git.ts, test/worktree-git.test.ts

### Approach

Teach the git-boundary seam to see a wedged working copy. `mergeReadiness`
gains a distinct mid-merge classification: a worktree-aware MERGE_HEAD probe
runs BEFORE the porcelain dirty check (a mid-merge tree is also dirty, so
ordering is load-bearing), and the returned verdict carries the MERGE_HEAD
sha, an ownership attribution, and whether MERGE_AUTOSTASH exists. Ownership
is repo-state-only and sole-ownership: the branch-set at the sha
(`for-each-ref --points-at`, server-side filter) must be non-empty and
consist entirely of `keeper/epic/*` branches to read as keeper-owned; any
foreign branch, an empty set, a probe failure, or a present MERGE_AUTOSTASH
reads as not-ours (callers must never abort those). Rebase/cherry-pick/revert
in-progress states (rebase-merge/rebase-apply dirs, CHERRY_PICK_HEAD,
REVERT_HEAD — mirror wt-status.c) and a stale index.lock are detected and
NAMED in the verdict detail so downstream reasons stop saying just "dirty",
but they are always foreign-shaped: detection only, no remediation.
`mergeBranchInto`'s conflict/timeout abort currently swallows its outcome —
surface a failed/timed-out abort as a new MergeResult arm carrying stderr.
Consolidate the three existing probe/abort helpers (hasMergeInProgress,
abortInterruptedMerge, abortMergeIfInProgress) rather than adding a fourth,
and bound every abort by GIT_LOCAL_TIMEOUT_MS (one is currently unbounded).

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/worktree-git.ts:544 — mergeReadiness; the dirty-first porcelain probe at :554 the MERGE_HEAD probe must precede; doc comment at :530 states the current fold-into-dirty design being replaced
- src/worktree-git.ts:463-494 — hasMergeInProgress + abortInterruptedMerge; the existing rev-parse MERGE_HEAD idiom to reuse; the abort at :492 is the unbounded one
- src/worktree-git.ts:935-949, :1021-1050 — abortMergeIfInProgress and mergeBranchInto's conflict/timeout paths whose abort outcome is currently discarded at :1038/:1043
- src/worktree-git.ts:132 — the MergeReadiness union; :76 MergeResult union; follow the discriminated-union + assertNever exhaustiveness convention
- src/worktree-git.ts:693 — KEEPER_EPIC_BRANCH_PREFIX for the ownership namespace

**Optional** (reference as needed):
- test/worktree-git.test.ts:1034-1126 — mergeReadiness coverage to extend (ready/off-branch/dirty/detached/untracked-only)
- test/worktree-git.test.ts:664-828 — mergeBranchInto conflict/abort coverage; model for the abort-failure arm
- test/helpers/fake-git.ts — fakeAsyncGit rules seam; no real git in the fast tier

### Risks

- Reordering the deliberate dirty-first probe changes verdict precedence for every caller — the off-branch-masking rationale at :522 must keep holding for non-merge dirt
- The new MergeReadiness/MergeResult arms trip exhaustiveness in downstream switches that task 2 owns; keep this task's changes compiling by exhaustively handling new arms at existing call sites with today's behavior (defer/skip), so this task lands green standalone

### Test notes

Fake-git rules: MERGE_HEAD probe exit 0 + sha → mid-merge wins over dirty;
for-each-ref returns sole keeper lane → owned; mixed/empty/timeout → foreign;
MERGE_AUTOSTASH present → not-ours; abort non-zero/124 → the new failure arm
with stderr; rebase-dir/CHERRY_PICK_HEAD/REVERT_HEAD/index.lock each named in
the verdict detail.

## Acceptance

- [ ] A working copy with MERGE_HEAD classifies as mid-merge (not generic dirty), carrying the sha, ownership attribution, and autostash presence
- [ ] Ownership reads keeper-owned only under the sole-ownership rule; foreign branch present, empty branch-set, probe failure/timeout, or autostash present all read as not-ours
- [ ] A failed or timed-out merge abort inside the merge routine surfaces as a distinct result carrying stderr instead of being discarded
- [ ] Rebase, cherry-pick, revert, and stale-index.lock states are named in the verdict detail, and no code path removes an index.lock or aborts a non-merge operation
- [ ] Every abort invocation is bounded by the local git timeout; the fast-tier suite passes with no real git

## Done summary
mergeReadiness now classifies a mid-merge shared checkout distinctly (MERGE_HEAD probed before dirty, carrying sha + sole-ownership attribution + autostash presence), names rebase/cherry-pick/revert/index.lock states in the dirty detail (detection only), and mergeBranchInto surfaces a failed/timed-out guarded abort as a distinct abort-failed arm; every abort is bounded by GIT_LOCAL_TIMEOUT_MS and the three probe/abort helpers are consolidated.
## Evidence
