## Description

**Size:** M
**Files:** src/git-worker.ts, src/derivers.ts, test/git-worker.test.ts, test/reducer.test.ts

### Approach

Extend keeper's git-worker to parse the `Job-Id:` and `Task:` trailers in
addition to `Session-Id:`, coalesce the session trailers into
`committer_session_id` (Session-Id preferred, else Job-Id), and carry a new
`task_ids` (multi-valued, collect-all) on the Commit wire struct. This
single change revives the dormant v45 per-session discharge arm in
`foldCommit` (because `committer_session_id` becomes non-null for jobctl
commits) and supplies the `task_id` needed by T2's link fold — with NO
schema bump (both fields ride the Commit event's JSON `data` blob).

Concretely: widen the git-log `--format` string at src/git-worker.ts:764-765
to request `%(trailers:key=Job-Id,valueonly,unfold,separator=...)` and
`%(trailers:key=Task,valueonly,...)` as additional `%x00`-delimited fields,
and widen the field-group stride parser at :806-833 (currently `i += 4`)
to consume the new fields. Coalesce via a named helper (reuse
`parseSessionIdTrailer` / `UUID_RE` for the UUID-valid session value;
Session-Id wins, else Job-Id; whitespace-only = absent; warn to stderr if
both present AND differ — a bug-signal since `job_id === session_id`).
`Task:` is multi-valued: collect ALL values, validate each against the
task-id shape, drop garbage. Add `task_ids: string[]` to `CommitMessage`
(:215-223) / `EnumeratedCommit` (:643); daemon.ts:1615 spread-serializes so
it rides automatically. In src/derivers.ts `extractCommit` (:1308) /
`CommitPayload` (:1274), decode `task_ids` defensively (default `[]` on
historical events lacking it — re-fold determinism). NO change to
`foldCommit`'s write logic in this task beyond confirming the per-session
arm now fires; the link fold is T2.

### Investigation targets

**Required** (read before coding):
- src/git-worker.ts:764-765 — git-log format string (only Session-Id today)
- src/git-worker.ts:806-833 — the `%x00` field-group stride parser (i += 4)
- src/git-worker.ts:215-223 — CommitMessage wire struct; :643 EnumeratedCommit; :824/:830 committer_session_id set
- src/derivers.ts:1177 UUID_RE, :1202 parseSessionIdTrailer (reuse), :1274 CommitPayload, :1308 extractCommit, :1403-1407 committer_session_id UUID-gated decode
- src/reducer.ts:2469 foldCommit per-session discharge arm (verify it now fires), :2511 global fallback
- src/daemon.ts:1615-1623 — Commit event build (spread-serialize)
- test/git-worker.test.ts:475-513 parseSessionIdTrailer cases, :401-413 real-git Bun.spawnSync idiom

**Optional:**
- apps/jobctl/jobctl/run_commit_work.py:474-512 — _append_job_id_trailer (Job-Id = session UUID, ifExists=doNothing)

### Risks

- `Job-Id` is the session UUID (passes UUID_RE) — verified. If a future Job-Id were non-UUID, the coalesce must still null-out rather than poison committer_session_id; keep the UUID gate on the coalesced value.
- Merge commits carry their own trailers — confirm the new extraction uses the same first-parent commit the file-list walk uses (git-worker.ts:813), no double-count.
- Widening the stride parser is fragile — an off-by-one drops/misaligns every field. Pin with a real-git test that round-trips a commit carrying all three trailers.

### Test notes

Add to test/git-worker.test.ts: real-git commits (via Bun.spawnSync + git interpret-trailers) carrying (a) Session-Id only, (b) Job-Id only, (c) both-equal, (d) both-differing (assert stderr warn + Session-Id wins), (e) neither, (f) one Task:, (g) multiple Task:. Assert committer_session_id + task_ids on the enumerated commit. Add to test/reducer.test.ts: a Job-Id-trailer Commit event now takes the per-session discharge arm (not global); a no-trailer historical Commit still global-discharges.

## Acceptance

- [ ] git-worker parses Session-Id, Job-Id, and Task trailers; committer_session_id coalesces Session-Id-else-Job-Id (UUID-gated); task_ids collects ALL Task: values; both-differing logs a stderr warn.
- [ ] CommitMessage/EnumeratedCommit carry task_ids; extractCommit decodes it defaulting [] on historical events.
- [ ] foldCommit's per-session discharge arm now fires for a Job-Id commit; no-trailer commit still global-discharges; no schema bump.
- [ ] New git-worker + reducer tests green; existing tests unaffected.

## Done summary

## Evidence
