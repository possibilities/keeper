## Description

**Size:** M
**Files:** src/autopilot-worker.ts (finalize + recover push), src/worktree-git.ts (remotePushFastForwardable), test/worktree-git.test.ts, test/autopilot-worker.test.ts, plugins/plan/test/worktree-finalize-degrade.test.ts

### Approach

Before the LOCAL merge in finalizeEpic (~src/autopilot-worker.ts:2588) and recover pass-2 (~:2842), add a turn-key-push pre-check: remote exists -> the branch has a push target (`git rev-parse --abbrev-ref @{push}`, NOT `@{upstream}`) -> `git push --dry-run` succeeds (GIT_TERMINAL_PROMPT=0). If any gate fails, emit a DISTINCT NON-STICKY skip-and-retry reason — finalize-side NOT `worktree-recover*`-prefixed (mirror the existing dirty/non-ff finalize skip), recover-side `worktree-recover*`-prefixed (stays auto-clearable) — and STOP cleanly, never merge then die on the push. REUSE src/commit-work/push.ts classifyPushError/pushCommitted (the existing taxonomy + GIT_TERMINAL_PROMPT=0) rather than re-implementing. Fix remotePushFastForwardable (src/worktree-git.ts:480-493): an UNRESOLVED remote-tracking ref (exists.code !== 0) must return NOT-fast-forwardable (→ skip-retry), not true.

### Investigation targets

**Required** (read before coding):
- src/autopilot-worker.ts:2588 (finalize push) + :2842 (recover push) + :2564-2572 / :2820-2827 (existing non-ff prechecks via gitRemotePushFastForwardable).
- src/worktree-git.ts:480-493 remotePushFastForwardable — the `exists.code !== 0 -> true` bug.
- src/commit-work/push.ts:72 classifyPushError (6 classes) + :203 pushCommitted — REUSE; the doc at :24-31 states the autopilot keys retries on these.
- Auto-clear scoping: src/autopilot-worker.ts:393 worktreeRecoverDispatchId, :405 WORKTREE_RECOVER_REASON_PREFIX, :421 recoverFailuresToClear, + the :2540 / :2797 reason-family comments.

**Optional**:
- plugins/plan/test/worktree-finalize-degrade.test.ts:107-110 — stands up a bare `origin`; the slow-test home for the push-failure proof.

### Risks

- Reason family: a finalize-side push-skip MUST NOT be `worktree-recover*`-prefixed (else wrongly auto-cleared); a recover-side one MUST be. Keep them distinct.
- Use `@{push}` not `@{upstream}` (a branch can push via push.default=current with no upstream). `git push --dry-run` is a probe, not an auth guarantee — but it catches no-remote / no-target / would-prompt, which is the goal.

### Test notes

- Pure (test/worktree-git.test.ts): remotePushFastForwardable on an unresolved ref → NOT fast-forwardable.
- Pure (test/autopilot-worker.test.ts): finalize/recover with no-upstream / no-target / dry-run-fail → distinct non-sticky skip-retry reason (correct family), no merge.
- Slow (worktree-finalize-degrade.test.ts): a real no-upstream / non-ff repo → finalize skips-and-retries (not sticky).
- Default `bun test` stays pure; typecheck + lint green.

## Acceptance

- [ ] finalize + recover pre-check push turn-key-ness (remote + `@{push}` + dry-run) BEFORE the local merge; non-turn-key → distinct non-sticky skip-retry (finalize: non-`worktree-recover*`; recover: `worktree-recover*`), no merge.
- [ ] remotePushFastForwardable returns not-fast-forwardable on an unresolved tracking ref.
- [ ] the push taxonomy reuses src/commit-work/push.ts (no duplication).
- [ ] pure + slow tests cover it; typecheck + lint green.

## Done summary
Added a pre-merge turn-key push gate (remotePushTurnKey: remote + @{push} + dry-run, reusing classifyPushError) so finalize + recover degrade to a distinct non-sticky skip-retry before the local merge instead of merging-then-dying; fixed remotePushFastForwardable to treat an unresolved remote-tracking ref as not fast-forwardable.
## Evidence
