## Description

**Size:** M
**Files:** src/worktree-git.ts, src/autopilot-worker.ts, test/worktree-git.test.ts, test/autopilot-worker.test.ts, test/worktree-git-premerge-realgit.slow.test.ts

### Approach

Make the fan-in pre-merge probe the base worktree before merging, and losslessly
auto-clean a dirty base when — and only when — the dirt is a provably-redundant
leak; degrade every other not-ready state to a non-sticky retry-skip so a dirty
base never blindly conflicts.

Behavioral contract:

- **Probe before merge.** In `provision()`'s fan-in loop, call the existing
  `mergeReadiness` on the base worktree before `gitMergeBranchInto`, exactly as
  finalize/recover already do. `ready` → merge unchanged (the clean path stays
  byte-identical).
- **New producer blob-equality probe** in `worktree-git.ts` (a sibling of
  `wouldClobberUntracked`, returning a discriminated `{ kind }` union — extend the
  union, never add booleans). Given the base worktree + the incoming rib branch,
  it classifies each dirty TRACKED path as *provably-redundant* iff its filtered
  working-tree blob (`git hash-object --path=<p>`, after one
  `git update-index -q --really-refresh` under the flock) equals the incoming
  branch's committed blob for that path AND that incoming blob differs from the
  base tip (HEAD) — i.e. the merge will re-apply exactly the content already in
  the working tree, so restoring to HEAD then merging is a true no-op on that
  path. A path that is an ADD (no `HEAD:<p>`), a DELETE, a mode-only diff
  (blob-identical, mode flipped), or untracked is classified NOT redundant. Any
  probe timeout / spawn failure → NOT redundant (fail safe).
- **Auto-clean only when ALL dirty paths are provably-redundant AND none is
  attributed to a live job.** Take the commit-work flock (as
  `mergeBranchInto`/`recoverSharedCheckoutMidMerge` do), `git restore --source=HEAD
  --worktree -- <exact proven pathspec>`, then **re-probe**; only a `ready`
  re-probe proceeds to merge. Anything else → retry-skip (never a blind merge —
  that is the original bug).
- **Live-job attribution is supplied by the reconciler, not read in the driver.**
  The reconciler pre-computes the live-attributed dirty-path set in
  `loadReconcileSnapshot` (producer side, keyed on the exact lane worktree path,
  normalized for trailing-slash and the macOS `/tmp`→`/private/tmp` symlink) and
  passes it into `provision`; the worktree driver keeps only its `GitRunner`. Any
  git/DB read failure fails **do-not-discard** (assume live-attributed).
- **Retry-skip contract.** Extend the provision result union with a `retry: true`
  variant (mirroring `finalizeEpic`'s degrade template): it mints NO sticky, does
  NOT consume the dispatch slot / stamp a cooldown / mint a `pending_dispatch`,
  and defers to the next cycle. BOTH provision consumers honor it — the
  per-launch producer step and the clustered-base fan-in loop (which currently
  sticky-mints a `close::<epic>` on any `!ok` and must now check `retry`).

Genuine-conflict routing and the grace→needs_human escalation are Task 2; this
task lands the probe, the lossless clean, and the retry-skip so the common
(redundant-leak) and transient cases stop wedging.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves. `src/autopilot-worker.ts` contains real NUL bytes that make BSD `grep`/`rg` silently report zero matches — navigate it with `grep -a`, `sed -n`, or the Read tool.*

**Required** (read before coding):
- src/worktree-git.ts:698-749 — `mergeReadiness(cwd, expectedBranch, run, incomingBranch?, pathExists?)`: probe most-specific-first; call before `mergeBranchInto`
- src/worktree-git.ts:766-811 — `wouldClobberUntracked`: the closest existing "read working state vs a tree" probe; model the new blob-equality probe on its shape (bounded reads, timeout→safe kind)
- src/worktree-git.ts:142-195 — `MergeReadiness` / `MergeResult` unions + the `{ kind }` discipline (exhaustive switch + assertNever)
- src/autopilot-worker.ts:2633-2715 — the `provision()` fan-in loop that merges blind (folds conflict+abort-failed into one `worktree-merge-conflict:` reason)
- src/autopilot-worker.ts:2750-2853 — `finalizeEpic`'s `retry:true` degrade template (the pattern to mirror for the provision retry-skip)
- src/autopilot-worker.ts:2498-2512 and :2594-2604 — the TWO provision consumers (clustered-base loop + per-launch step) that must both honor `retry:true`
- src/commit-work/attribution.ts:55,196-233 — `liveDirtyPaths` producer-side dirty-attribution reader + its `project_dir`-keyed-on-toplevel gotcha (a linked worktree resolves to the worktree path)

**Optional** (reference as needed):
- src/worktree-git.ts:1181+ — `mergeBranchInto` (flock, abort-failed/lock-timeout/local-timeout degrades) — the flock idiom to reuse for `git restore`
- test/worktree-git.test.ts:1079+ — the faked-`GitRunner` idiom (~25 `mergeReadiness` cases) to extend for the blob-equality probe

### Risks

- **Eating real work** — the discard gate must be airtight: filtered-blob-identical to the *incoming* rib AND incoming≠base AND unattributed AND tracked-non-mode-only. Any doubt → escalate, never restore. A wrong anchor (restoring to HEAD when the merge will not re-apply the path) reintroduces the ruled-out data-loss.
- **Filter/eol false positives** — comparing raw bytes instead of `hash-object --path` filtered blobs will misjudge redundancy under `.gitattributes`/`autocrlf`; the faked-runner tier cannot catch this, only the real-git slow test can.
- **Flock races** — `git restore` and `update-index --refresh` are index/worktree mutations; run them under the commit-work flock with a bounded timeout, degrading a lock-timeout to retry-skip (never a blind restore).
- **Both-consumer omission** — if the clustered-base loop is not updated to honor `retry`, a transient skip sticky-mints a `close::<epic>` row.

### Test notes

- Pure faked-`GitRunner` cases in `test/worktree-git.test.ts` for the blob-equality probe: redundant (matches incoming, incoming≠base) → cleanable; ADD / DELETE / mode-only / untracked / incoming==base → not-redundant; timeout → not-redundant.
- `test/autopilot-worker.test.ts` via `makeFakeWorktreeDriver` (`provisionFail` hook): redundant+unattributed → clean+merge+dispatch; not-redundant or attributed → retry-skip minting no sticky and consuming no slot; both consumers honor `retry`.
- New real-git slow test `test/worktree-git-premerge-realgit.slow.test.ts` (gated by `KEEPER_RUN_SLOW`) reproducing the fn-1106.7 shape and proving lossless clean under `.gitattributes`/`autocrlf`/a mode flip — this is the safety proof the faked tier cannot give.

## Acceptance

- [ ] The fan-in pre-merge probes the base worktree before merging; a `ready` base merges with behavior byte-identical to today.
- [ ] A base worktree whose only dirt is provably-redundant (filtered working-tree blob equals the incoming rib's committed blob, incoming differs from base, unattributed to a live job) is auto-cleaned under the flock and the merge then succeeds.
- [ ] A dirty base that is not provably-redundant-and-unattributed — including ADD, DELETE, mode-only, untracked, filter-ambiguous, attributed-to-a-live-job, or any probe timeout — is never discarded and never blind-merged; it degrades to a retry-skip that mints no sticky and consumes no dispatch slot, cooldown, or pending dispatch.
- [ ] Both provision consumers (the per-launch step and the clustered-base fan-in loop) honor the new retry-skip variant.
- [ ] A real-git slow test reproduces the redundant-leak incident shape and demonstrates the clean is lossless under `.gitattributes`, `autocrlf`, and a mode-only change; the fast suites remain green.

## Done summary

## Evidence
