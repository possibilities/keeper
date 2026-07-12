## Description

**Size:** M
**Files:** src/worktree-git.ts, src/db.ts, src/reducer.ts, src/autopilot-worker.ts, test/autopilot-worker.test.ts

### Approach

Make `mergeBranchInto` (:1554) capture the conflicted-file set BEFORE its internal abort (:1636
destroys the `U` index) — extract `git diff --name-only --diff-filter=U` producer-side and
return it as `conflictedFiles` on the `MergeResult` conflict variant (:98). Add a nullable
`conflicted_files` column to `dispatch_failures` (`addColumnIfMissing` pattern db.ts:3524/:3800;
one `SCHEMA_STEPS` entry) and populate it through the synthetic event that mints the
`DispatchFailed` — the FOLD stores the event-carried set, NEVER a live git re-probe
(`dispatch_failures` is deterministic-replayed; re-fold must be byte-identical). Cover ALL
conflict paths: fan-in pre-merge, finalize, and the new refresh (`.4`). Today conflicted files
live only as free-text in `reason` — this makes them structured.

### Investigation targets

*Verify before relying — the repo moves.*

**Required:**
- src/worktree-git.ts:1554 `mergeBranchInto`, :1636 internal abort (capture BEFORE it), :98 `MergeResult.conflict`
- src/db.ts:5441 `dispatch_failures` schema, :5474-5476 (deterministic-replayed), :3524/:3800 `addColumnIfMissing`
- the `DispatchFailed` synthetic-event mint path (producer captures, fold stores)

**Optional:**
- docs/adr/0039 (escalation pipeline)

### Risks

Re-fold determinism: the conflicted set MUST come from the event payload, never a live re-probe in the fold. Shares the db.ts schema ladder with `.3` (dep) and worktree-git.ts with `.1` (dep).

### Test notes

Faked git: a conflicting merge returns `conflictedFiles`; the fold stores them from the event; re-fold is byte-identical. The escalation brief consumes the structured set without stderr regex when present.

## Acceptance

- [ ] `mergeBranchInto` returns the structured conflicted-file set (captured before its internal abort) on a conflict.
- [ ] `dispatch_failures` carries a nullable `conflicted_files` field, populated from the escalation event for fan-in, finalize, AND refresh conflicts; re-fold is deterministic.
- [ ] The schema change is one forward-only `SCHEMA_STEPS` entry with `SCHEMA_FINGERPRINT` re-pinned.

## Done summary
mergeBranchInto captures the conflicted-file set (git diff --diff-filter=U for fan-in, merge-tree plumbing for finalize) before its internal abort; threaded through WorktreeDriver into a new nullable dispatch_failures.conflicted_files column via one forward-only v120 SCHEMA_STEPS entry, populated only from the DispatchFailed event payload for deterministic re-fold.
## Evidence
