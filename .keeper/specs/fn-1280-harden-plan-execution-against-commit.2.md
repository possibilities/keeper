## Description

**Size:** M
**Files:** plugins/plan/src/verbs/epic_close.ts, plugins/plan/src/verbs/close_finalize.ts, plugins/plan/test/saga-close-finalize.test.ts

### Approach

A close whose commit fails must leave the epic RE-CLOSABLE: both the torn done-on-disk def AND the leaked close-claim marker must be undone, not just the def. The close verb writes the `done` def to disk then commits via `emitMutating`; on a commit failure `emitMutating` runs any `onCommitFailure` hook and then `process.exit(1)`. That exit fires AFTER the hook and bypasses `close_finalize`'s `emitFinalizeError` → `clearCloseMarker` chokepoint (the process dies inside the in-process `closeEpic` delegate), so a rollback hook alone fixes the torn def but leaves the marker leaked → `CLOSE_ALREADY_CLAIMED` wedge.

Two moves: (1) register an `onCommitFailure` rollback hook on the close verb's `emitMutating` — `snapshotForRollback([epicPath])` taken right before the `done`-def write, hook = `restoreForRollback(...)` with `ctx.projectPath` as the restore cwd — mirroring epic-create / done. (2) Release the close-claim marker on the same commit-failure path, before the exit: the marker's owner (`close_finalize`) threads a marker-clear callback into `closeEpic`, composed into the `onCommitFailure` hook, so `epic_close` stays marker-agnostic and neither shared `emitMutating` nor the standalone `cli.ts` close path (which holds no marker) is touched. The composed hook MUST return `restoreForRollback`'s `RollbackResult` (not the marker-clear's `void`) so `emitMutating`'s reopened-window stderr signal survives.

Fail-closed policy: clear the marker ONLY on a clean rollback (def restored). On an INCOMPLETE rollback (non-null `RollbackResult` — the torn `done` def could not be restored), KEEP the marker as a visible needs-human wedge rather than silently converting it into an uncommitted `done` that the working-tree fold reads as done with no close commit in git. Do not change `/work` or `/close` launch mechanics. (Acceptable alternative if it proves cleaner in investigation: a scoped throwing variant of `emitMutating` for the close verb plus a catch at both `runEpicClose` call sites routing to `emitFinalizeError` — better observability but broader blast radius; the callback approach is preferred.)

### Investigation targets

*Verify before relying — planner-verified at authoring time; the repo moves.*

**Required:**
- plugins/plan/src/verbs/epic_close.ts — `runEpicClose` write+emit (~:98-117): add the snapshot before the def write (~:106) and the hook to the emit opts; pass `ctx.projectPath` as restore cwd. Its header comment: the ONLY self-committing close-saga verb.
- plugins/plan/src/verbs/close_finalize.ts:347 — `closeEpic` delegate (thread the marker-clear callback); :119 / :583 (`finalizeClaimEpicId`); :125-140 (`emitFinalizeError` → `clearCloseMarker`, the chokepoint the exit bypasses).
- plugins/plan/src/emit.ts — `emitMutating`: the `onCommitFailure` hook (~:106, run ~:121-127) and the `process.exit(1)` after it (~:152).
- plugins/plan/src/commit.ts — `snapshotForRollback` (~:106) / `restoreForRollback` (~:130-164); note this is a MUTATE of an existing file (rollback rewrites the pre-close bytes, not unlink).
- plugins/plan/src/session_markers.ts — `clearCloseMarker` / `clearIfMatches` (~:88-114) — non-throwing, matches on session id + epic id.
- plugins/plan/src/verbs/cli.ts:223 — the standalone `runEpicClose` caller: must keep its clean `commit_failed` + exit-1 contract and no-op its absent marker.

**Optional:**
- plugins/plan/src/verbs/epic_create.ts (~:172 + :212) and done.ts (~:328) — exemplar `onCommitFailure` registration sites to mirror; commit 5631e979 is the pattern source.

### Risks

- The two failure modes (torn def / leaked marker) have two owners — a hook that only rolls back the def leaves the epic wedged. The marker-clear must run within the hook (before the exit).
- Rollback-incomplete must fail closed (keep the marker); clearing it there trades a visible wedge for a silent uncommitted-`done` the fold still reads as done.
- Do not regress the standalone `cli.ts` close path (no marker, real-stdout `commit_failed` envelope).

### Test notes

Clone the `saga-done-commit-atomic` pattern (fake-VCS `failNextCommit` + `gitBaseline`; assert restored `.keeper` bytes and no commit landed). Add a close-commit-failure conformance test proving: on a clean rollback the epic is re-closable (a subsequent close succeeds, not `CLOSE_ALREADY_CLAIMED`) with no torn def; and on a rollback that cannot restore the def, the marker is retained (fail-closed). Plan tier; real-git blocks gated behind `KEEPER_PLAN_RUN_SLOW`.

## Acceptance

- [ ] After a close whose commit fails with a clean rollback, the epic has no torn (written-but-uncommitted) `done` def and no leaked close-claim marker — a re-close succeeds instead of hitting `CLOSE_ALREADY_CLAIMED`.
- [ ] On a rollback that cannot restore the def, the close-claim marker is retained as a visible needs-human wedge, not silently cleared.
- [ ] The standalone `keeper plan epic close` commit-failure contract (its `commit_failed` envelope + exit 1, no marker) is unchanged.
- [ ] The plan suite is green, including a new close-commit-failure conformance test.

## Done summary
Close-commit-failure now unwinds cleanly: epic_close registers a snapshot/rollback onCommitFailure hook and close_finalize threads a marker-clear callback composed into it, so a clean rollback restores the done def and releases the close-claim marker (re-closable), while an incomplete rollback keeps the marker as a fail-closed needs-human wedge. The standalone cli.ts close path is untouched (no marker, same commit_failed+exit-1 contract). Added close-commit-failure conformance tests to saga-close-finalize.test.ts.
## Evidence
