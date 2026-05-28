## Description

**Size:** M
**Files:** src/reducer.ts, src/types.ts, test/reducer.test.ts

### Approach

Rewrite `projectGitStatus` (src/reducer.ts:941-1008) to consume the new file-centric `GitSnapshot` payload and compute per-(session, file) attribution + per-job rollups inside the open `BEGIN IMMEDIATE` transaction. Five integrated passes, in order:

**Pass 1 — explicit attribution upsert.** For each dirty file F in the payload:
- Query `events` for the latest mutation event per session that touched F (Write/Edit/MultiEdit/NotebookEdit → `tool_input.file_path == F.path` OR `tool_input.file_path == F.orig_path`; AND `bash_mutation_targets` JSON includes F.path; UNION).
- For each (session_id, last_mutation_ts, op) tuple: UPSERT `file_attributions(project_dir, session_id, file_path) VALUES (...) ON CONFLICT DO UPDATE SET last_mutation_at = excluded.last_mutation_at, op = excluded.op, last_event_id = excluded.last_event_id, updated_at = excluded.updated_at WHERE excluded.last_mutation_at > last_mutation_at`.

**Pass 2 — inferred attribution.** For each dirty file F where Pass 1 found zero explicit attributions AND F.mtime_ms is non-null:
- Query `events` for `(PreToolUse:Bash → PostToolUse:Bash)` brackets in any session whose cwd is inside `project_dir` AND whose interval contains F.mtime_ms.
- For each matching session: UPSERT `file_attributions(..., op='inferred', source='inferred', last_mutation_at = F.mtime_ms, ...)` — same upsert shape as Pass 1.

**Pass 3 — render attribution materialized view.** For the `git_status.dirty_files[]` JSON the client reads, materialize `attributions[]` per file by joining `file_attributions` against `jobs` (for title + state):
```sql
SELECT fa.session_id, fa.last_mutation_at, fa.last_commit_at, fa.op, fa.source,
       j.title, j.state
FROM file_attributions fa
LEFT JOIN jobs j USING (session_id)
WHERE fa.project_dir = ? AND fa.file_path = ?
  AND fa.last_mutation_at > COALESCE(fa.last_commit_at, 0);
```
The `WHERE last_mutation_at > COALESCE(last_commit_at, 0)` clause IS the discharge rule. Embed the result as `attributions[]` per file in the `git_status.dirty_files` JSON.

**Pass 4 — per-job rollups.** UPDATE `jobs` for every session that has at least one active attribution under this project_dir:
- `git_dirty_count` = count of files this session is still attributed to (active, undischarged) AND the file is in the snapshot's `dirty_files`
- `git_unattributed_to_live_count` = project-wide broadcast: count of dirty files whose attribution set contains no live session (state IN ('working','stopped')) — this is the OLD orphan semantic, drives readiness predicate 6.5
- `git_orphan_count` = project-wide broadcast: count of dirty files with ZERO active attributions (truly mystery, no tool/bash/inferred match) — new strict semantic
- Fan into `epics.jobs[]` + `epics.tasks[].jobs[]` via existing `syncJobIntoEpic` helper.

**Pass 5 — symmetric retract.** Extend `retractGitStatus` (src/reducer.ts:1031-1066): when a `GitRootDropped` event fires, also DELETE rows from `file_attributions` WHERE `project_dir = ?`. Symmetric with the existing zero-clear of `jobs.git_*_count`.

All five passes inside the existing `BEGIN IMMEDIATE` envelope, same transaction as cursor advance. Cursor + projection invariant preserved.

The `extractGitSnapshot` defensive parser (src/reducer.ts:883-914) is widened for the v31 payload shape: parse `dirty_files[].mtime_ms`, drop the embedded `jobs[]` rollup that the producer no longer emits.

### Investigation targets

**Required:**
- src/reducer.ts:883-914 — `extractGitSnapshot` (widen for v31 shape)
- src/reducer.ts:941-1008 — `projectGitStatus` (the rewrite seam)
- src/reducer.ts:1031-1066 — `retractGitStatus` (extend for file_attributions DELETE)
- src/reducer.ts:1609-1706 — `Job` row shape + `buildEmbeddedJob` (carry new + renamed columns into embedded arrays)
- src/reducer.ts:2134 — `syncJobIntoEpic` fan-out call site
- src/reducer.ts:3382-3428 — `drain` transaction envelope (BEGIN IMMEDIATE + cursor advance)
- test/reducer.test.ts re-fold determinism cases (the 7400-line file's existing patterns)

**Optional:**
- src/git-worker.ts:498-514 — old `touchesForJob` (deleted in task 5, but read for the SQL shape we're absorbing)
- practice-scout: "use SQLite window functions or a self-join for last-mutation vs last-commit comparison; index on (file_path) and (session_id) separately"

### Risks

- SQL complexity: the explicit-attribution pass joins `events` against the payload's dirty file list. The bash_mutation_targets column is a JSON array — needs `json_each(bash_mutation_targets)` or `WHERE bash_mutation_targets LIKE ...` (the partial index from task 2 scopes the scan). Bench under a realistic event count.
- Discharge rule precision: `last_mutation_at > COALESCE(last_commit_at, 0)` — confirm `last_mutation_at` is unix-ms (matches what task 4's foldCommit writes). Schema enforces both as REAL (SQLite numeric).
- Multi-attribution overcount in `git_dirty_count`: a file attributed to sessions A and B counts toward both A's and B's git_dirty_count. That's intentional — co-authorship is honest — but document it so consumers (board.ts) don't double-count at aggregate level.
- Inferred-attribution determinism: re-fold rebuilds the same inferred set because mtimes are frozen in the GitSnapshot payload (task 5). Verify with a re-fold determinism test that runs the full `DELETE FROM file_attributions; rewind cursor; drain` cycle and asserts byte-identical row hashes.
- `git_unattributed_to_live_count` definition depends on `jobs.state` — which mutates outside this fold (SessionEnd, Killed). A session state flip between snapshots changes the count without a new GitSnapshot event. Document: the count is updated on every GitSnapshot fold, not continuously. Acceptable — predicate 6.5 reads it lazily.
- Symmetric retract: GitRootDropped needs to walk the projection's persisted `git_status.jobs` JSON to enumerate which sessions had attributions for the dropped project, zero their per-job counts, AND delete file_attributions rows for that project_dir. Walk + delete inside the open transaction.

### Test notes

test/reducer.test.ts: this task adds the biggest test surface — target ≥20 fold cases. Cover at minimum:
- Happy path: single mutation event → fold → file_attributions row created → snapshot fold materializes attributions[] in git_status JSON.
- Discharge: mutation, then Commit event with trailer, then snapshot → attribution row's last_commit_at > last_mutation_at → file no longer in active set → git_dirty_count for that session decrements.
- Re-discharge: mutation, commit, RE-mutation → file back in active set.
- Global discharge: mutation by session A, commit with NULL trailer touching same file → A's attribution cleared.
- Multi-attribution: two sessions both mutate same file → both in attributions[].
- Inferred: bash event with mtime inside its bracket, no explicit derivation → inferred attribution lands.
- Truly orphan: dirty file in git_status, no event touches it, no bracket matches → git_orphan_count++ (new strict semantic).
- Unattributed-to-live: file attributed only to ended sessions → git_unattributed_to_live_count++.
- Re-fold determinism: full DELETE + rewind + drain reproduces byte-identical `file_attributions` rows + `git_status` JSON.
- Retract: GitRootDropped clears all file_attributions for project_dir + zeros per-job counts.

## Acceptance

- [ ] `projectGitStatus` rewritten in five passes; all inside open BEGIN IMMEDIATE with cursor advance
- [ ] `file_attributions` rows upserted with discharge-rule semantics (`last_mutation_at > COALESCE(last_commit_at, 0)` defines active)
- [ ] Inferred attribution computed via mtime bracketing against PreToolUse/PostToolUse Bash intervals — frozen-in-payload mtimes preserve re-fold determinism
- [ ] `git_status.dirty_files[].attributions[]` JSON materialized per file with `{session_id, title, state, last_touch_at, op, source}` shape
- [ ] `jobs.git_dirty_count` per-job, `jobs.git_unattributed_to_live_count` + `jobs.git_orphan_count` project-broadcast
- [ ] `syncJobIntoEpic` fan-out unchanged in shape; embedded jobs[] arrays carry both new + renamed columns
- [ ] `retractGitStatus` extended to DELETE from file_attributions on GitRootDropped, symmetric with jobs-side zero-clear
- [ ] ≥20 fold cases in test/reducer.test.ts cover happy/discharge/re-discharge/global-discharge/multi-attribution/inferred/truly-orphan/unattributed-to-live/re-fold-determinism/retract
- [ ] Re-fold determinism: rewind + drain reproduces byte-identical projection rows

## Done summary

## Evidence
