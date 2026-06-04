## Description

**Size:** S
**Files:** src/readiness.ts, test/readiness.test.ts

### Approach

Extend the close-row per-root claim so a quiescent done-but-unapproved epic
on a dirty repo holds its root. Today the close-row claim
(applySingleTaskPerRootMutex pass-1, :1195-1202) fires only when
`isRootOccupant(closeVerdict)` AND `epicLevelRunning`
(`anyEmbeddedJobWorking || anyEmbeddedJobHasRunningSubagent`). For a
fully-done epic both are false, so a git close-verdict never claims the
root — the case task .1 alone leaves unfixed. Add a git-verdict disjunct to
that gate: claim when `isRootOccupant(closeVerdict)` AND (`epicLevelRunning`
OR closeVerdict is `git-uncommitted`/`git-orphans`). Keep the claim scoped
to the epic's OWN project_dir (`effectiveRoot(null, projectDir)`) — do not
broaden to other roots; preserve the fn-655/fn-663 narrowing that prevents
cross-root phantom locks. `evaluateCloseRow`'s 6.5 arm (:889-919, gated on
`epic.status==="done"`) is the producer; no change there.

### Investigation targets

**Required** (read before coding):
- src/readiness.ts:1195-1202 — close-row claim gate (epicLevelRunning), the edit site
- src/readiness.ts:1188-1193 — the fn-655/fn-663 JSDoc explaining why the claim is scoped (do not regress it)
- src/readiness.ts:889-919 — evaluateCloseRow predicate 6.5 (close-verdict producer)
- src/readiness.ts:1226-1240 — close-row pass-2 (confirm a git close row is blocked, never reaches the ready tiebreak)
- test/readiness.test.ts:1244-1347 — cross-epic per-root tests (template)

**Optional** (reference as needed):
- src/readiness.ts:1129-1150 — close-row scoped-attribution JSDoc (fn-655/fn-663 rationale)

### Risks

- Phantom lock: the close-row claim was deliberately narrowed (fn-663) to avoid claiming roots it shouldn't. The git-verdict disjunct must claim only the epic's OWN project_dir, and only after the outer isRootOccupant guard passes. Add a test that a git close row does NOT claim an unrelated root.
- Double-claim: when a task in the same epic also claims the root (pass-1 task loop), the close-row add is idempotent (Set) — verify no behavior change.

### Test notes

- epic status=done, approval=pending, dirty repo, NO live jobs/subagents → close-row git-uncommitted claims the root → a sibling epic's ready task on that root demoted to single-task-per-root. Assert this FAILS with only task .1's change and passes with this gate edit.
- A git close row does not claim a different root (no phantom lock).
- Regression: a non-git, non-running close row still does not claim the root (epicLevelRunning path intact for the non-git case).

## Acceptance

- [ ] Close-row claim gate fires for a quiescent done+pending epic on a dirty repo (git close-verdict), claiming the epic's project_dir root.
- [ ] A sibling epic's ready task on that root is demoted to single-task-per-root (test passes).
- [ ] The claim stays scoped to the epic's own project_dir — no cross-root phantom lock (test pins it).
- [ ] Non-git close-row behavior unchanged (epicLevelRunning still gates the running path).

## Done summary
Added a git-verdict disjunct to the close-row pass-1 per-root claim so a quiescent done-but-unapproved epic on a dirty repo holds its own project_dir root through the approval window; scoped strictly to the epic's project_dir to preserve the fn-655/fn-663 cross-root narrowing. Three new tests pin the claim, the no-phantom-lock scoping, and the unchanged non-git path.
## Evidence
