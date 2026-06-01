## Description

**Size:** M
**Files:** src/reducer.ts, src/db.ts, keeper/api.py, test/reducer.test.ts, test/db.test.ts, test/schema-version.test.ts, CLAUDE.md, README.md

### Approach

Stamp a deterministic task→committing-session link into the epics
projection so the planctl consumer (T3) can prefer the committing session.
In `foldCommit` (src/reducer.ts:2384), adjacent to the file_attributions
discharge and gated on BOTH `committer_session_id != null` AND a non-empty
`task_ids`, for each `task_id` in the Commit payload: find the embedded job
element whose `job_id == committer_session_id` under that task in
`epics.tasks[].jobs[]`, and set a new `last_commit_for_task_at` field to
the commit's frozen `committed_at` (producer-time ms → seconds, mirroring
the existing discharge timestamp conversion). Bump the embedded job's
`last_event_id`/`updated_at` and re-sort via `sortEmbeddedJobs` (never
append) so the read-surface patch fires and re-fold is byte-identical. Add
the field to `EmbeddedJobElement` (:3528); ensure `buildEmbeddedJob` (:3635)
PRESERVES it across job-tick re-syncs (read it back from the prior embedded
element — it is a Commit-event fact, NOT a jobs-row fact, so it must survive
`syncJobIntoEpic`'s OLD-element carve-out spread at :3788 without being
clobbered). The link rides the existing JSON-TEXT `jobs` cell on `epics` —
NO new real column, so v48→v49 is a whitelist-only bump: SCHEMA_VERSION 48→49
(src/db.ts:60) + add 49 to keeper/api.py SUPPORTED_SCHEMA_VERSIONS (:136) in
THIS change + test/schema-version.test.ts. Shell-insert handling: if no
embedded job exists yet for `committer_session_id` under the task (Commit
folds before the claim), decide deterministically (recommend: no-op + lose
the link rather than shell a job element foldCommit doesn't otherwise own —
a re-fold replays in id order so a real worker's claim precedes its commit;
document the choice). Update CLAUDE.md (revise v45 bullet + add v49 bullet)
and README.md Architecture (name 3 trailer sources + v49 paragraph).

### Investigation targets

**Required** (read before coding):
- src/reducer.ts:2384-2549 foldCommit (per-session arm 2469, global 2511, ts conversion 2404)
- src/reducer.ts:3528 EmbeddedJobElement, :3567 JobsRowForSync, :3635 buildEmbeddedJob, :3619 sortEmbeddedJobs, :3682 syncJobIntoEpic, :3737 TaskElement, :3788 OLD-element carve-out spread
- src/db.ts:60 SCHEMA_VERSION, :650 CREATE_EPICS (tasks/jobs JSON-TEXT), :4710-4717 v47→v48 migration block (pattern; NOT needed if no real column), :1432 addColumnIfMissing
- keeper/api.py:136 SUPPORTED_SCHEMA_VERSIONS, :471 get_epic (embedded items ride opaque — new field surfaces with no SQL change)
- test/db.test.ts migration idiom (seed old DB, set meta schema_version, reopen); test/schema-version.test.ts:56
- CLAUDE.md "Commit discharge is content-aware (schema v45)" bullet; README.md ~855-895

### Risks

- **Re-fold determinism (headline):** foldCommit today writes only file_attributions; this adds an epics write — a NEW cross-fold-path seam. Must be a pure function of the Commit payload + existing epics row; no wall-clock/env/fs/liveness; bump last_event_id; re-sort not append. A cursor=0 re-fold over a mixed pre-/post-v49 log MUST reproduce byte-identical epics rows.
- **Clobber risk:** if buildEmbeddedJob re-emits the element from the jobs row and drops last_commit_for_task_at, a later job tick wipes the link. It must read the field back from the prior embedded element.
- **Commit-before-claim ordering:** define and test the no-embedded-job-yet path deterministically.
- **Sequencing with fn-668 T3:** same schema slot + reducer + api.py — land after fn-668 T3 (epic dep wired) to avoid double-bump collision; version number allocated at code time.
- **keeper-py whitelist is a hard host-wide gate:** forgetting 49 fails every commit-work on the host AND breaks render-approve-context's own get_epic read.

### Test notes

test/reducer.test.ts: a Commit event with committer_session_id + task_ids stamps last_commit_for_task_at on the matching embedded job under each task; multi-Task stamps all; no-op when committer_session_id null or task_ids empty; a later job-tick re-sync preserves the link (clobber guard); cursor=0 re-fold byte-identical. test/db.test.ts: v48→v49 migration preserves rows (whitelist bump). test/schema-version.test.ts green.

## Acceptance

- [ ] foldCommit stamps last_commit_for_task_at (frozen committed_at, seconds) on the embedded job whose job_id == committer_session_id, for every task_id in the payload; gated on both non-null; bumps last_event_id; re-sorts.
- [ ] The link survives a later syncJobIntoEpic re-sync (clobber guard verified); buildEmbeddedJob preserves it.
- [ ] SCHEMA_VERSION = 49; keeper/api.py SUPPORTED_SCHEMA_VERSIONS includes 49; no new real column (rides JSON-TEXT); migration + schema-version tests green.
- [ ] cursor=0 re-fold over mixed pre-/post-v49 Commit events reproduces byte-identical epics rows.
- [ ] CLAUDE.md + README.md updated (3 trailer sources + v49 link).

## Done summary

## Evidence
