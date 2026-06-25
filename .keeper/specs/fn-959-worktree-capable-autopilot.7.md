## Description

**Size:** M
**Files:** src/autopilot-worker.ts, src/worktree-git.ts, test/*.slow.test.ts

### Approach

Producer-only recovery, never a fold. Per cycle / boot-drain: for each live
lane worktree, detect an interrupted merge (`MERGE_HEAD` present) → `git merge
--abort` (guarded) → `git worktree prune --expire now` → retry on the next
cycle (idempotent, no in-process self-heal beyond the level-triggered retry).
Add a deterministic done-but-unmerged backstop: enumerate `keeper/epic/*`
branches (and `git worktree list --porcelain`), cross-reference against done
epics, and merge any whose epic is done but whose base never reached the
default branch — DECOUPLED from the 1800s recent-done window so a daemon
restart between epic-done and merge-to-default cannot orphan the merge.

### Investigation targets

**Required** (read before coding):
- src/autopilot-worker.ts:2011 (existing producer fs-probe in the cycle), boot-drain sequence, :1366-1374 (sticky DispatchFailed pattern).
- src/collections.ts:255 (DONE_EPICS_REAP_WINDOW_SEC=1800 — why the scan must be independent of it).
- src/worktree-git.ts (this epic, task .3) — MERGE_HEAD detect/abort/prune primitives.

### Risks

- The scan reads git → it is a PRODUCER, NEVER a fold (re-fold determinism).
- Must not double-merge an already-merged base — `merge-base --is-ancestor` skip guards idempotency.
- A wedged merge past the window is caught here, not by the recent-done read — this is the backstop, so it must be self-sufficient.

### Test notes

Real-git `*.slow.test.ts`: simulate a crash leaving MERGE_HEAD → recovery aborts + prunes + retries; a done epic whose base never merged → backstop merges it to default. `bun run test:full` mandatory.

## Acceptance

- [ ] Interrupted merges detected via MERGE_HEAD, aborted, pruned (`--expire now`), and retried level-triggered (no in-process self-heal).
- [ ] Deterministic done-but-unmerged `keeper/epic/*` scan merges orphaned bases to default, independent of the 1800s window.
- [ ] All recovery is producer-only; idempotent (no double-merge).

## Done summary

## Evidence
