## Description

**Size:** S
**Files:** src/worktree-git.ts, src/autopilot-worker.ts, test/worktree-git.test.ts, test/autopilot-worker.test.ts

### Approach

Add a `{ kind: "missing-source" }` variant to the `MergeResult` union (src/worktree-git.ts:62-72)
with a forward-facing doc comment in the existing inline style. At the top of `mergeBranchInto`
(~:566), BEFORE the `merge-base --is-ancestor` check (~:573-577) and before any lock is acquired,
probe the source ref via the injected `run` seam:
`git rev-parse --quiet --verify --end-of-options "refs/heads/<sourceBranch>^{commit}"`. On non-zero
exit, return `{ kind: "missing-source" }` (no lock, no merge attempted). Mirror the in-module
`branchExists` idiom (~:269) — the `refs/heads/` prefix is required so a phantom lane name cannot
DWIM-match a remote-tracking ref/tag; `^{commit}` peels tags; `--end-of-options` guards `-`-leading names.

In `provision`'s fan-in pre-merge loop (src/autopilot-worker.ts ~:2208-2219), `continue` (skip) on
`merge.kind === "missing-source"` instead of returning the `worktree-merge-conflict` failure. Do NOT
throw — the loop is wrapped in try/catch (`worktree-provision-failed`); a throw would convert a
lossless no-op into a sticky failure. Update the inline comment at ~:2206-2207 to name the skip.

CRITICAL correctness boundary: ONLY a non-zero exit from the new rev-parse probe yields
`missing-source`. A `merge-base --is-ancestor` or `merge` failure AFTER a passing probe stays a
genuine error/`conflict` (is-ancestor exit >=128 is a real error) — do not extend missing-source to
the merge path.

The other two `MergeResult.kind` sites need no behavior change: `finalizeEpic` is pre-guarded by
`gitBranchExists` and `recoverWorktrees` sources from live branches; both use non-exhaustive
`if (kind === "conflict")` so `ty` will not flag them. Leave them as silent fall-through with a
one-line comment noting the variant is unreachable/idempotently safe there.

### Investigation targets

**Required** (read before coding):
- src/worktree-git.ts:62-72 — `MergeResult` union (add the variant here)
- src/worktree-git.ts:269-280 — `branchExists` `refs/heads/` rev-parse idiom to mirror
- src/worktree-git.ts:566-606 — `mergeBranchInto`; is-ancestor probe ~:573-577; MERGE_HEAD probe ~:593-595
- src/autopilot-worker.ts:2206-2220 — provision pre-merge loop, comment, `worktree-merge-conflict` mint
- test/worktree-git.test.ts:555-680 — `mergeBranchInto` tests; collision-prone conflict tests ~:617 and ~:652; `recordingLock` ~:560
- test/helpers/fake-git.ts — `fakeAsyncGit` (unmatched call defaults to exit 0), `argvStartsWith`, `argvHas` (exact-token — will NOT match `^{commit}`)
- test/autopilot-worker.test.ts:4455-4547 — `createWorktreeDriver` provision tests; the `rev-parse --verify --quiet refs/heads` fakeRun rule ~:4486/:4547

**Optional:**
- ~/docs/keeper-worktree-phantom-lane-finalize-fix.md — full root-cause record + alternatives

### Risks

- Test-matcher collision: the new probe shares the `rev-parse --verify` prefix with the existing
  MERGE_HEAD stub rules (~:617/:652). Disambiguate new fake rules on the `^{commit}` token via a
  substring/suffix check (`t.endsWith("^{commit}")`), NOT `argvHas`. The `--quiet --verify` flag
  order further separates it from the MERGE_HEAD probe's `--verify --quiet` for free.
- Masking a real failure: if `missing-source` is mistakenly extended to the merge/is-ancestor path,
  a genuine git error is swallowed as a no-op (silent data risk). Source the variant ONLY from the probe.
- Autopilot fakeRun clobber: the existing `refs/heads`-prefix rule (~:4486/:4547) means "branch not
  yet created"; the new phantom test must key on `^{commit}` so a resolvable pre-merge can still be modeled.

### Test notes

Fast in-process tier only, via the faked git runner seam (NO real git; the `.slow` real-git file is out of scope).
- worktree-git.test.ts: (a) phantom/unresolvable source (`^{commit}` probe non-zero) -> returns `missing-source`;
  assert NO `merge --no-edit`, NO `merge --abort`, and NO lock acquired (mirror the already-merged no-lock assertion);
  (b) resolvable-but-genuinely-conflicting source -> still returns `conflict` (in ~:652 add a `^{commit}` rule
  returning exit 0 so the existing no-MERGE_HEAD conflict path stays covered).
- autopilot-worker.test.ts: provision with a phantom entry in `preMerges` -> loop `continue`s, provision returns
  `{ok:true}`. Cover ordering both ways: phantom-then-conflict AND conflict-then-phantom (phantom skipped, real conflict still fails loud).
- Verify the two existing conflict tests (~:617, ~:652) still pass.

## Acceptance

- [ ] `MergeResult` has a `{ kind: "missing-source" }` variant with a forward-facing doc comment
- [ ] `mergeBranchInto` returns `missing-source` for an unresolvable `refs/heads/<source>^{commit}` ref, before any lock/merge-base, taking no lock on that path
- [ ] A real merge conflict and an is-ancestor/merge error (exit >=128) are NOT classified as `missing-source`
- [ ] `provision`'s pre-merge loop skips `missing-source` (via `continue`, never throw); the epic close proceeds; a genuine conflict still mints `worktree-merge-conflict`
- [ ] Fast-tier tests cover: lone phantom (no lock/merge), mixed phantom+conflict both orderings; the two existing conflict tests stay green
- [ ] README worktree-mode block (~:3196) and the autopilot-worker.ts ~:2206-2207 inline comment name the missing-source no-op vs content-conflict-fails-loud distinction
- [ ] `ty` clean; `bun test` green; committed via `keeper commit-work`

## Done summary
mergeBranchInto now probes the source ref before any lock/merge-base and returns a new missing-source MergeResult for a phantom lane branch; provision's pre-merge loop skips it so a mixed-mode close no longer hard-fails, while real conflicts and post-probe git errors still fail loud.
## Evidence
