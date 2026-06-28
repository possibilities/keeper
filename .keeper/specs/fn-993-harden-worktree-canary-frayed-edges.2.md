## Description

**Size:** M
**Files:** src/commit-work/flock.ts, src/worktree-git.ts, src/commit-work/git-exec.ts, src/autopilot-worker.ts, test/autopilot-worker.test.ts, test/commit-work-foundation.test.ts

### Approach

EDGE-2a (bound the flock). `CommitWorkLock.acquire` (src/commit-work/flock.ts:152-181)
is a BLOCKING `flock(LOCK_EX)` via synchronous bun:ffi — it cannot be interrupted
in-process (no signal/timer reaches a blocked FFI syscall in Bun). The codebase
already has `tryAcquire` (:189-217, `LOCK_EX | LOCK_NB` → null on EWOULDBLOCK) —
the building block. Add an OPT-IN deadline acquirer: poll `tryAcquire` with
bounded exponential backoff + jitter (start ~20ms, cap ~500ms) until a deadline
(~30-60s), returning failure on timeout. (This is PRODUCER code — a bounded
backoff-sleep is acceptable; the test-tier "poll, don't sleep" rule is about
tests, not producers. Keep the lock FILE permanently — never unlink on release.)
Thread it as the worktree merge acquirer ONLY (src/worktree-git.ts:48-51
`LockAcquirer` / `defaultLockAcquirer` → `mergeBranchInto` :765 / :798-822) —
DO NOT change cli/commit-work.ts:466,556 (the default verb stays a plain blocking
acquire). On timeout, `mergeBranchInto` returns a NEW `MergeResult` kind
`lock-timeout` (src/worktree-git.ts:62-81) → `MergeLaneResult`
(src/autopilot-worker.ts:2758-2769) → the finalize switch (a `worktree-finalize-*`
retry-skip, OUTSIDE the recover prefix) + the recover pass-2 switch (a
`worktree-recover-*` retry-skip, INSIDE) — a SKIP, never a freeze, never a
respawn.

EDGE-2b (bound the local git ops). The merge/teardown LOCAL git ops omit
`timeoutMs`: mergeBranchInto's rev-parse / merge-base / `merge --no-edit` /
`merge --abort` (:775-815), removeWorktree (:840), pruneWorktrees (:390),
deleteBranch (:342), isAncestorOf. git-exec.ts already has `timeoutMs` +
`GIT_SPAWN_TIMEOUT_CODE=124` (the fn-990 network-push hardening). Add a NEW
`GIT_LOCAL_TIMEOUT_MS` (smaller than the 120s `GIT_PUSH_TIMEOUT_MS`) and pass it
to these local ops so a blocking git hook can't wedge the cycle; a local-op
timeout maps to the same retry-skip family.

### Investigation targets

**Required** (read before coding):
- src/commit-work/flock.ts:152-181 (acquire), :189-217 (tryAcquire LOCK_NB — the building block), :44 (LOCK_NB), :52 (EWOULDBLOCK)
- src/worktree-git.ts:48-51 (LockAcquirer / defaultLockAcquirer), :765 / :798-822 (mergeBranchInto lock acquire/release), :62-81 (MergeResult union — add lock-timeout), the local ops omitting timeoutMs (:775-815, :840, :390, :342)
- src/commit-work/git-exec.ts:34-42 (timeoutMs), :50 (GIT_SPAWN_TIMEOUT_CODE=124), :58 (GIT_PUSH_TIMEOUT_MS), :139-165 (spawn-timeout impl)
- src/autopilot-worker.ts:2758-2769 (MergeLaneResult) + the finalize + recover pass-2 switches (map lock-timeout to a correctly-scoped retry-skip)
- cli/commit-work.ts:466,556 (the default blocking acquire — MUST stay unchanged)

### Risks

- The deadline acquirer is async (LOCK_NB + awaited backoff); mergeBranchInto already awaits, so feasible — thread it without breaking the synchronous default acquirer used by cli/commit-work.ts.
- Default commit-work path UNCHANGED (opt-in injected at the worktree merge site only).
- lock-timeout / local-op-timeout reasons correctly scoped: finalize → worktree-finalize-*, recover → worktree-recover-*. No in-process respawn — degrade to a skip only.

### Test notes

flock deadline: real FFI in-process (test/commit-work-foundation.test.ts:276-313
pattern — hold via `acquire`, assert the deadline variant times out; model on the
:301-310 contention test). MergeResult `lock-timeout` flow: pure fake-runner (a
lock-timeout acquirer → finalize/recover retry-skip, correctly-scoped reason, no
hang). Local-op timeout: fake-runner (a timed-out local op → retry-skip). Confirm
the default (non-worktree) commit-work path is unchanged.

## Acceptance

- [ ] a worktree merge-path lock acquisition exceeding the deadline degrades to a skip-retry (finalize worktree-finalize-* / recover worktree-recover-*), never a freeze
- [ ] the default commit-work acquire (cli/commit-work.ts) is UNCHANGED (plain blocking)
- [ ] the merge/teardown local git ops carry a local timeoutMs so a blocking git hook can't wedge the cycle
- [ ] the lock-timeout / local-op-timeout reasons are correctly prefix-scoped (no finalize reason satisfies isWorktreeRecoverReason)
- [ ] the flock deadline variant is tested (real FFI in-process) + the MergeResult lock-timeout flow tested (fake-runner)

## Done summary

## Evidence
