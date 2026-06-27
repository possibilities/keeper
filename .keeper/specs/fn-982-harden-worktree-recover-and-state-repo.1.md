## Description

**Size:** M
**Files:** src/autopilot-worker.ts, src/daemon.ts, test/autopilot-worker.test.ts (+ close-path file for prune-at-close, likely plugins/plan/src/verbs/close_finalize.ts or the close-sink in src/autopilot-worker.ts)

### Approach

Keep the recover pass's existing fail-LOUD behavior: a genuine recover merge conflict still emits a
`DispatchFailed` (reason `worktree-recover-conflict`) and blocks dispatch on that `close::<epicId>` key.
The `failedKeys` gate is already per-key (src/autopilot-worker.ts:1432), so only that epic is blocked —
the rest of the board keeps moving. Keep the existing `isEpicDone` + is-ancestor (already-merged) skips.
Do NOT add a recency-bounded allowlist (it would regress the "git is authority, recover regardless of age" backstop).

ADD LEVEL-TRIGGERED AUTO-CLEAR (the core fix): make a recover failure clear itself once the underlying
git is resolved, so a human just fixes the git (deletes the junk branch / resolves the conflict) and the
next cycle clears the block — no `retry_dispatch`.
- Add an `emitDispatchCleared` method to the `ConfirmRunningDeps` interface, symmetric with `emitDispatchFailed`
  (src/autopilot-worker.ts ~:3319 impl, ~:806 interface) — it posts a `{ kind: "dispatch-cleared", payload: {verb,id} }` message to main.
- In src/daemon.ts add a handler for `kind === "dispatch-cleared"` (symmetric with the DispatchFailed mint ~:4299)
  that calls the EXISTING `mintDispatchClearedEvent(verb, id)` (the same path `retry_dispatch` uses) and wakes the reconciler.
- In the recover glue (src/autopilot-worker.ts ~:3476-3502), after computing this cycle's recover `failures`,
  compute `newRecoverFailureIds = new Set(failures.map(f => f.epicId ?? worktreeRecoverDispatchId(f.dir)))`;
  then for each existing `dispatch_failures` row that is RECOVER-ORIGINATED and whose id is NOT in
  `newRecoverFailureIds`, `emitDispatchCleared({verb:"close", id})`.

CRITICAL CORRECTNESS GUARD: scope the auto-clear to RECOVER-ORIGINATED rows ONLY — filter on
`reason === "worktree-recover-conflict"` (or a recover marker on the row). A recover failure and a normal
close-sink failure can share the `close::<epicId>` key; auto-clear must NEVER dismiss a legitimate
non-recover close failure. (You will likely need the row's `reason`/`dir` in the `failedKeys` snapshot —
thread that through, or read dispatch_failures rows for the recover-reason subset.)

PRUNE AT SUCCESSFUL CLOSE: when an epic close merges the lane into the default branch, delete the lane
branch (`git branch -D keeper/epic/<id>`) ONLY when it is fully merged (is-ancestor true) — so a DONE epic
never leaves a recover-able branch (the fn-973 pileup root cause). The recover pass keeps its own prune of
already-merged leftovers as a backstop. NEVER delete an unmerged/diverged branch (that would lose work — a
diverged branch must go through the merge → conflict → fail-loud path instead).

### Investigation targets

**Required:**
- src/autopilot-worker.ts:2555-2704 — `recoverWorktrees`; conflict emit :2674-2680; is-ancestor skip :2654; isEpicDone guard :2650
- src/autopilot-worker.ts:3476-3502 — recover glue / call site (where to compute the auto-clear set + emit)
- src/autopilot-worker.ts:3319 (emitDispatchFailed impl), :806 (interface), :2961-2968 (failedKeys snapshot — extend to carry reason for recover-scoping), :1432 (per-key gate), :390 (worktreeRecoverDispatchId)
- src/daemon.ts:4299 — handleDispatchFailedMint (mirror for dispatch-cleared); find `mintDispatchClearedEvent` + the retry_dispatch handler that already calls it
- src/reducer.ts:3698 foldDispatchFailed (UPSERT, has `reason`), :3748 foldDispatchCleared (idempotent DELETE); src/db.ts:1107 dispatch_failures schema (PK verb,id; has reason)
- the close-sink/merge-success path for prune-at-close (close_finalize.ts or autopilot-worker close path) + src/worktree-git.ts is-ancestor/branch helpers

**Optional:**
- src/daemon.ts:280-297 gcUnretryableDispatchFailures (the only existing auto-clear precedent — boot-time key GC)

### Risks

- Auto-clear CLOBBER: clearing a non-recover close failure that shares the key — guard strictly on the recover reason.
- prune-at-close deleting an unmerged/diverged branch → lost work. Gate on is-ancestor (fully merged) ONLY.
- Event-sourcing: `DispatchCleared` must round-trip through main as a synthetic event (reuse mintDispatchClearedEvent); foldDispatchCleared stays a pure idempotent DELETE (no wall-clock/env/fs; re-fold safe).
- Don't regress fail-loud into silent: a genuine unresolved conflict must STILL block until the git is fixed.

### Test notes

Fast in-process tier, faked git (makeRecoveryGit, test/autopilot-worker.test.ts:5219-5315; recover tests :5317-5494). Cases:
- recover conflict STILL emits a failure (fail-loud preserved; failedKeys blocks that epic only).
- a previously-failed recover lane whose branch is now ABSENT (or now is-ancestor) → emitDispatchCleared on next cycle (auto-clear).
- auto-clear does NOT clear a `close::<epic>` row whose reason is a normal close failure (clobber guard).
- successful close with a fully-merged lane → branch deleted; an unmerged/diverged branch → NOT deleted.
- already-merged leftover skipped (idempotency preserved).

## Acceptance

- [ ] Recover conflict emits a loud `DispatchFailed` (reason worktree-recover-conflict) blocking only that epic
- [ ] `emitDispatchCleared` + a daemon `dispatch-cleared` handler reuse `mintDispatchClearedEvent`; recover glue auto-clears resolved recover keys each cycle
- [ ] Auto-clear is scoped to recover-reason rows ONLY (never clobbers a normal close failure)
- [ ] Successful close deletes a fully-merged lane branch; never deletes an unmerged/diverged one
- [ ] No recency-bounded allowlist added; isEpicDone + is-ancestor guards preserved
- [ ] Fast-tier tests cover fail-loud, auto-clear-on-resolve, clobber-guard, prune-at-close, idempotency; `ty` clean; `bun test` green; committed via keeper commit-work

## Done summary
Recover failures now level-triggered auto-clear once the git resolves (scoped to worktree-recover* reasons, never clobbering a finalizeEpic close failure); successful close prunes its fully-merged lane base (is-ancestor gated). Added emitDispatchCleared dep + daemon dispatch-cleared handler reusing mintDispatchClearedEvent.
## Evidence
