## Description

**Size:** M
**Files:** src/autopilot-worker.ts, src/worktree-git.ts, src/commit-work/git-exec.ts, src/commit-work/push.ts

### Approach

Three hardenings on the finalize/recover push, plus cleanup.

1. **Ordering + first-push admission.** Run `remotePushTurnKey` (authoritative,
accurate reason, admits a legit first push via its dry-run) BEFORE
`gitRemotePushFastForwardable` in BOTH finalize (:2594/:2610) and recover
(:2913/:2927). AND fix `gitRemotePushFastForwardable` (worktree-git.ts:554-567)
so an UNRESOLVED `origin/<default>` tracking ref returns a "defer/unknown"
(do NOT block) instead of false — otherwise a never-pushed-default repo
deadlocks even after turn-key passes. Keep the would-clobber / readiness checks
BEFORE the merge; only the two push prechecks reorder.

2. **No-hang.** Add a spawn timeout (a new GitExecOptions field,
git-exec.ts:27-34, consumed in spawnGitExec :99-122) AND
`GIT_SSH_COMMAND="ssh -o BatchMode=yes -o ConnectTimeout=10"` to BOTH the real
pushes (autopilot-worker.ts:2633-2636, :2950-2953) AND the turn-key precheck
dry-run (push.ts:156-163 already sets BatchMode; add the timeout) — an SSH TCP
stall does not trip GIT_TERMINAL_PROMPT. A timeout is a TRANSIENT retry
(distinct non-sticky reason: finalize → a `worktree-finalize-*` retry reason;
recover → `worktree-recover-*` auto-clearable), NEVER the sticky
`worktree-finalize-push-failed`. buildGitEnv (git-exec.ts:70-82) is caller-wins;
ensure BatchMode is guaranteed even if a human GIT_SSH_COMMAND is present.

3. **Diagnostics.** Log (one line each) the finalize done-guard-miss and
retry-skip reasons so the silent finalize paths are diagnosable.

4. **Provenance (rule #0).** Strip fn-id provenance from src/autopilot-worker.ts
comments (the dense fn-NNN tags); keep forward-facing present-tense prose.

### Investigation targets

**Required** (read before coding):
- src/worktree-git.ts:554-567 — gitRemotePushFastForwardable (the unresolved-ref classification to fix)
- src/autopilot-worker.ts:2593-2617 (finalize prechecks), :2913-2935 (recover prechecks), :2633-2636 + :2950-2953 (the real pushes)
- src/commit-work/push.ts:156-163 — remotePushTurnKey (the dry-run precheck; already BatchMode)
- src/commit-work/git-exec.ts:27-34 (GitExecOptions), :70-82 (buildGitEnv caller-wins), :99-122 (spawnGitExec — where the timeout lands)

### Risks

- Timeout classification: a transient timeout (exit 124 / killed) must be distinguishable from a hard push reject so it maps to retry, not the sticky failure.
- GIT_SSH_COMMAND precedence: a human's custom value must not lose BatchMode — augment, don't silently replace or silently leave unset.

### Test notes

Pure fake-runner: never-pushed-default (unresolved origin/<default>) → first
push admitted (turn-key passes, FF defers), distinct reason, NOT deadlocked; a
simulated push timeout → transient retry reason, not sticky. Slow real-git: a
no-upstream / never-pushed repo completes its first finalize push.

## Acceptance

- [ ] remotePushTurnKey runs before gitRemotePushFastForwardable in finalize and recover
- [ ] an unresolved origin/<default> no longer forces a permanent non-FF skip — a never-pushed-default first finalize push is admitted
- [ ] the real pushes + the turn-key precheck run with BatchMode + a spawn timeout; a hang is bounded
- [ ] a push timeout degrades to a transient retry (distinct reason), never the sticky push-failed
- [ ] finalize done-guard-miss / retry-skip reasons are logged
- [ ] no fn-id provenance remains in the touched autopilot-worker.ts comments

## Done summary

## Evidence
