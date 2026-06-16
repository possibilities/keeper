## Description

**Size:** M
**Files:** src/restore-set.ts (new), test/restore-set.test.ts (new)

The keystone: a CLI-side, read-time module that derives the crash-restore candidate set from keeper.db — boundary-free, ordered, filtered — with no daemon round-trip required.

### Approach

New `src/restore-set.ts` exposing a pure-ish derivation over a read-only DB connection (the `cli/search-history.ts` `openDb({readonly:true})` precedent — NOT a socket collection; `runQuery` is hard-wired `FROM ${table}` and cannot host a replay derivation). Membership = `jobs` rows in `state='killed'` whose `close_kind ∈ {server_gone, pid_died}` (crash-like), PLUS the `unknown`/legacy-NULL backstop resolved via the burst-heuristic (gap-cluster of Killed rowids; large/boot-associated cluster qualifies, isolated Killed does not). Exclude `window_gone_server_alive`. Then filter: require `backend_exec_session_id`; exclude `plan_verb='work'` autopilot workers; exclude rows whose `job_id` already occupies a live backend (the UUID-liveness dedup / idempotence guard); exclude rows idle beyond a cutoff constant (default 7 days) but COUNT and surface the excluded number. Order candidates by `window_index` (nulls sink to the tail by `created_at` then `job_id`, reusing the `compareRestoreAgents` total-order shape). Return display label = latest `title`, resume target = `job_id`.

### Investigation targets

**Required** (read before coding):
- cli/search-history.ts:109 — `openDb({readonly:true})` CLI-side computed-read precedent
- src/server-worker.ts:1104-1174 — proof a socket collection can't host this (`FROM ${descriptor.table}` only)
- scripts/restore-agents.ts:212-232 `compareRestoreAgents` (window-order total-order comparator to reuse), :361 `fetchLiveJobsOrNull` (live skip-set, now computable from the same DB read)
- src/exit-watcher.ts:128 — the `created_at >= 5min` age-gate precedent for the idle cutoff
- src/db.ts `openDb` signature + readonly option

**Optional**:
- The recorded incident: `state='killed'` rows around the 2026-06-16 12:24 burst — the membership fixture

### Risks

- The `unknown`/legacy backstop is the only path for rows killed before T1 lands; its burst-heuristic must use stable rowid/event_id order, never `ts` (boot-sweep Killed events are `Date.now()`-stamped).
- Empty live-set (first boot / zero candidates) must return cleanly, not error.
- Idle-cutoff false-negatives: a recently-active session just over the cutoff — print the excluded count so it's visible, never silent-drop.

### Test notes

Build a fixture DB (`freshDbFile()`) seeding killed jobs with each close_kind + window_index + various ages; assert the candidate set, ordering, and excluded-count. Replay the real incident's killed cohort as a regression fixture. Pure module — no subprocess, no daemon.

## Acceptance

- [ ] `src/restore-set.ts` derives candidates from a read-only DB connection (works daemon-down).
- [ ] Membership = crash-like `close_kind` (+ unknown/legacy burst backstop); `window_gone_server_alive` excluded.
- [ ] Filters applied: backend coords, autopilot workers, already-live UUID dedup, idle cutoff with printed excluded count.
- [ ] Candidates ordered by `window_index` (nulls to tail); resume target = job_id, label = latest title.
- [ ] Unit tests incl. the 2026-06-16 incident cohort as a regression fixture; `bun run test:full` green.

## Done summary

## Evidence
