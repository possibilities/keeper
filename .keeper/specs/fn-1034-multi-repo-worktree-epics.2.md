## Description

**Size:** S
**Files:** src/autopilot-worker.ts, src/reducer.ts, test/autopilot-worker.test.ts

Give each repo's finalize failure its OWN sticky dispatch-failure row so N per-repo finalizes on
one epic never collide on the single `close::<epic>` PK, and a recover-sweep row for one repo can
never overwrite/auto-clear an operator-required finalize block for another.

### Approach

Key per-repo finalize failures `close::worktree-finalize:<epic>-<repoHash>`, mirroring the
EXISTING `close::worktree-recover:<slug>` pattern (verb `close`, single `::`, safe slugged token —
passes `parseDispatchKey`). In the finalize driver loop, replace the shared `closeKeyEpicId(info)`
key with the per-repo synthetic key (carry `repoDir` in the `dir`/reason as today). Preserve the
failure-class discipline unchanged PER ROW: `worktree-finalize-non-fast-forward` stays a VISIBLE
operator sticky (outside the recover auto-clear prefix); dirty/off-branch/lock-timeout stay
non-sticky `retry` skips minting no row. Add a producer LEVEL-CLEAR: when a repo's finalize later
succeeds (or its lane is gone), emit `DispatchCleared` for that repo's synthetic key — exactly how
`recoverFailuresToClear` clears recover rows. `retry_dispatch` targets the per-repo key. Confirm
the daemon merge-escalation sweep notifies `planner@<epic>` per repo (each carrying its own
`dir`), and that `gcUnretryableDispatchFailures` accepts the new key shape (it must — valid verb,
single `::`).

### Investigation targets

**Required** (read before coding):
- src/autopilot-worker.ts:2951 — finalize driver loop (`emitDispatchFailed` :2962, `closeKeyEpicId` :2981)
- src/autopilot-worker.ts:3118 — `finalizeEpic` (no-base skip :3127, done-gate :3141, non-ff :3188)
- src/autopilot-worker.ts — `worktreeRecoverDispatchId` + `recoverFailuresToClear` (the recover key + reason-prefix level-clear to mirror); `recoverWorktrees` :3627
- src/dispatch-command.ts:59 — `parseDispatchKey` (rejects 2nd `::` / non-work|close|approve verb)
- src/daemon.ts:287 — `gcUnretryableDispatchFailures` (orphan-sweep on malformed keys); merge-escalation sweep :5496 (`merge_escalated_at IS NULL` gate)
- src/reducer.ts:3979 — `foldDispatchFailed` upsert (`merge_escalated_at` preserved :3996)

**Optional** (reference as needed):
- CLAUDE.md Autopilot paragraph — the finalize failure-key discipline invariant (this task's edit must keep it true; docs updated in task `.5`)

### Risks

- The recover auto-clear is scoped by reason-prefix over open recover-reason rows; the new
  per-repo finalize key must NOT accidentally match that prefix (keep `worktree-finalize:` distinct from `worktree-recover:`).
- `repoHash` must be stable + collision-free across cycles (reuse the same dir-hash `worktreePathFor` uses) so the level-clear targets the same row it minted.

### Test notes

Two repos, one finalizes clean and one hits `worktree-finalize-non-fast-forward`: assert distinct
rows, the clean repo mints nothing, the failed repo's row survives and is `retry_dispatch`-able,
and a later clean finalize level-clears it. Assert a recover row for repo A cannot dismiss a
finalize block on repo B. Assert `parseDispatchKey` accepts the new key.

## Acceptance

- [ ] Per-repo finalize failures land on `close::worktree-finalize:<epic>-<repoHash>` — distinct row per repo, no collision with recover rows or siblings
- [ ] `worktree-finalize-non-fast-forward` stays a visible operator sticky; transient skips stay non-sticky; failure-class discipline preserved per row
- [ ] Producer level-clears a repo's synthetic row once that repo finalizes clean / its lane is gone
- [ ] `retry_dispatch` targets the per-repo key; `parseDispatchKey` + `gcUnretryableDispatchFailures` accept it; merge-escalation notifies per repo
- [ ] Tests green

## Done summary
Per-repo worktree-finalize failures now key on close::worktree-finalize:<epic>-<repoHash> (reusing worktreePathFor's dir-hash) so N per-repo finalizes never collide on close::<epic> or a recover row, plus a producer level-clear that self-clears a repo's row once it finalizes clean. Provision fan-in conflicts stay epic-keyed so the merge-escalation sweep is unchanged.
## Evidence
