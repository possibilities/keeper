## Description

**Size:** M
**Files:** src/plan-worker.ts, test/plan-worker.test.ts, test/integration.test.ts

Files deleted while the daemon was down never fire an `onDelete`, so without
a reconciliation pass they leave permanent ghosts. After the boot scan
enumerates on-disk files, retract any projection id (within configured roots)
that has no backing file.

### Approach

- In the plan-worker boot path, after the existing full scan
  (`scanRoot` over `.planctl/{epics,tasks}/*.json`) has run for all roots,
  collect the set of on-disk epic ids and task ids actually seen.
- Read the projection's known ids that belong to the configured roots: epic
  ids from `epics`, task ids from the decoded `epics.tasks` arrays (reuse the
  seed read). Scope by root using the epic's `project_dir` so an epic from an
  unconfigured root is never retracted.
- For each projection id with no matching on-disk file, post the task 2
  tombstone message (`plan-epic-deleted` / `plan-task-deleted`) so main folds
  a retraction. Reuse the task 2 fold path — no new event types.
- Run the sweep AFTER the snapshot emissions (so a moved/rewritten file is
  re-emitted, not spuriously retracted) and gate it on `shuttingDown`.

### Investigation targets

**Required** (read before coding):
- src/plan-worker.ts:420-487 — boot scan (`scanRoot`, the `.planctl/{epics,tasks}` enumeration) the sweep extends
- src/plan-worker.ts:500-548 — `seedFromDb` (the projection-id read to diff against)
- src/plan-worker.ts (onDelete tombstone emission from task 2) — the message shapes to reuse
- src/db.ts — `resolvePlanRoots` (root scoping) and the `epics.project_dir` column for root attribution

**Optional** (reference as needed):
- test/plan-worker.test.ts:258-298 — seed test pattern; test/integration.test.ts:696-925 — plans e2e harness

### Risks

- Over-retraction is the danger: a transient read error, an unconfigured root, or a file mid-rewrite must NOT be read as "deleted." Scope strictly to configured roots, diff against actually-enumerated files (not a stale list), and run after snapshot emission.
- Multi-root: the projection spans all roots; the sweep must only retract ids attributable to a root it actually scanned this boot.

### Test notes

- Seed a projection with an epic + tasks, scan a root whose files for some of them are absent, assert exactly the absent ids are retracted and present ones untouched.
- Assert an epic whose `project_dir` is outside the configured roots is never retracted.
- Integration: fold some plan files, stop the daemon, delete a task file and an epic file on disk, restart, assert the projection reconciles (element spliced / epic row gone) without a live `onDelete`.

## Acceptance

- [ ] boot sweep retracts projection ids (epic + embedded task) with no backing file, scoped to configured roots, after snapshot emission
- [ ] no over-retraction: unconfigured-root epics and mid-rewrite/transient-error files are never retracted
- [ ] downtime delete of a task and an epic file is reconciled on restart with no live `onDelete`
- [ ] suite green

## Done summary
Added a boot-reconciliation sweep to the plan worker: after every root's boot scan records its on-disk census (markSeen), sweep() retracts any projection id (epic + embedded task) with no backing file, scoped to configured roots via the epic's project_dir and run after snapshot emission. Retractions reuse the existing plan-epic-deleted/plan-task-deleted tombstone path. Guards against over-retraction (filename-keyed census so mid-rewrite parse failures count as present; out-of-scope epics never touched).
## Evidence
