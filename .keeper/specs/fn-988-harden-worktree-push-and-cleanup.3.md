## Description

**Size:** S
**Files:** src/worktree-plan.ts (worktreePathFor), test/worktree-plan.test.ts, (confirm) test/autopilot-worker.test.ts / test/worktree-git.test.ts path comparisons

### Approach

Add a stable repo disambiguator to worktreePathFor (src/worktree-plan.ts:155-159): fold a short stable hash of the realpath'd repoDir into the `~/worktrees/<repoName>-<hash>--<slug>` dir, so two same-basename repos with a same-id epic can't collide. It is a PURE function of (repoDir, branch) — both the producer (provision) and removeWorktree compute it identically, so the path-equality comparisons still hold. Keep paths legible + deterministic.

### Investigation targets

**Required** (read before coding):
- src/worktree-plan.ts:155-159 worktreePathFor + :180 baseWorktreePath + :281 per-node worktreePath.
- Path comparisons that MUST survive: src/autopilot-worker.ts:2487-2488 (provision registration, stripTrailingSlashPath) and src/worktree-git.ts:755-757,781 (removeWorktree samePath).

**Optional**:
- A stable short-hash helper already in the repo (reuse; avoid a new dep).

### Risks

- The disambiguator MUST be a pure function of inputs both sides see (repoDir + branch) — no wall-clock / random. Both provision + teardown derive it, so equality holds.
- Confirm NO lane path is persisted/cached across the change (worktree mode re-derives each cycle — verify, don't assume).

### Test notes

- Pure (test/worktree-plan.test.ts): two same-basename repos + same epic id → distinct lane paths; same repo + epic → a stable path across calls.
- Confirm the existing lifecycle/fork slow tests still pass (the path shape changed).
- typecheck + lint green.

## Acceptance

- [ ] worktreePathFor disambiguates same-basename repos (distinct lane paths); deterministic + pure.
- [ ] provision-registration + removeWorktree path comparisons still hold.
- [ ] no persisted old-format lane path across the change.
- [ ] pure tests + the existing slow tests green; typecheck + lint green.

## Done summary

## Evidence
