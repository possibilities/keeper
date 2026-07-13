## Description

**Size:** M
**Files:** src/worktree-git.ts, src/autopilot-worker.ts, src/daemon.ts, test/worktree-git.test.ts, test/autopilot-worker.test.ts, docs/problem-codes.md

### Approach

Per ADR 0054: a producer sweep backs up and cleans shared-checkout dirt ONLY on proof that
every writer is dead. Writers are enumerable as sessions whose recorded cwd is the shared
checkout; the sweep fires only when no cwd-matched job is working, every one is
grace-stale, (pid, start_time) probes find no live writer, and MERGE_HEAD is absent
(mid-merge stays with its own classification). The clean primitive is a backup-then-CLEAN
sibling of the lane force-remove — factor the shared snapshot core (staged/unstaged/
untracked + bounded index line, same spool env + format, idempotent snapshot-id dedup on
retry, symlink-out-of-tree guarded) WITHOUT regressing the lane-remove path; the clean is
reset + untracked removal, never ignored files. The sweep never mints or clears the dirty
row — a successful clean lets the existing dirty tracker's positive-evidence level-clear
observe the clean tree next cycle; a failed backup never cleans; ambiguity (any live or
unprovable writer) pages once via the existing page-once discipline. Edit the
problem-codes shared_checkout_jam entry to note the self-heal.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/worktree-git.ts:1914-2120 — the spool: resolveLaneDirtSpoolDir/KEEPER_LANE_DIRT_SPOOL_DIR, backupThenForceRemoveWorktree (:1943 — force-REMOVES; your sibling KEEPS the checkout), snapshotUntrackedNode/isSafeLaneRelativePath guards (:2051), serializeLaneDirtIndex (:2072), laneDirtSnapshotId (:1916 — derive a shared-checkout id scheme alongside)
- src/autopilot-worker.ts:1392 — createSharedCheckoutDirtyTracker; src/daemon.ts:1977 buildSharedDirtyObservation (the level-clear the sweep feeds)
- src/proc-starttime.ts — the (pid, start_time) identity helper
- src/reconcile-core.ts:674-685 — the shared-checkout distress row ids (page-once, level-clear-only contract)

### Risks

- Cleaning under a live writer corrupts in-flight work — the cwd+liveness+grace+MERGE_HEAD gate chain is the entire safety story; any inconclusive probe refuses.
- The factored snapshot core must keep the lane-remove path byte-equivalent (fn-1271's tests stay green).

### Test notes

FakeGitRunner + injected liveness: all-writers-dead past grace → backup then clean, row
clears next cycle; live/working/unproven writer → refuse + page-once; MERGE_HEAD → refuse;
backup failure → no clean; retry dedups the snapshot; ignored files survive the clean.

## Acceptance

- [ ] Shared-checkout dirt with all cwd-matched writers provably dead past the grace is snapshotted to the spool then cleaned, and the dirty row level-clears without operator action
- [ ] Any live, working, or unprovable writer — or a merge in progress — refuses and pages exactly once
- [ ] A failed backup never cleans; retries dedup snapshots; ignored files are never discarded
- [ ] The lane force-remove path's behavior and tests are unchanged

## Done summary

## Evidence
