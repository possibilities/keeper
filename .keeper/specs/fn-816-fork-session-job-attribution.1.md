## Description

**Size:** S
**Files:** src/reducer.ts, test/reducer-lifecycle.test.ts, CLAUDE.md, README.md, docs/exec-backend.md (src/db.ts read-only reference)

### Approach

In `projectJobsRow`'s `UserPromptSubmit` arm (`src/reducer.ts:6224`), AFTER
the `isKilledTaskNotification(extractPrompt(event))` early-break (~:6243) and
BEFORE the existing `db.run(UPDATE …)` (~:6268), seed a minimal row IF ABSENT,
guarded by `event.pid != null`:
`INSERT INTO jobs (job_id, created_at, cwd, pid, last_event_id, updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(job_id) DO NOTHING`
with `job_id=event.session_id`, `created_at=event.ts`, `cwd=event.cwd`,
`pid=event.pid`, `last_event_id=event.id`, `updated_at=event.ts`. Leave
`title_source`, `plan_verb`, `plan_ref`, `config_dir`, `profile_name`,
`transcript_path`, `start_time` NULL (schema defaults / nullable). Do NOT
discharge `pending_dispatches` (that stays SessionStart-spawn-insert-only).
The seed lands `state='stopped'` (schema default); the existing UPS UPDATE
immediately flips it to `'working'` and its `active_since = CASE WHEN state !=
'working' THEN ts` stamps `active_since = ts` — identical to a normal
session's first-prompt transition (a conscious, consistent value, not an
accident). The post-switch title rule (~:6826) seeds `title` from a later
`session_title`, and the backend-coords fold (:6759) stamps pane/session
(REQUIRED for restore visibility) — both now hit a present row. Then update
the stale "SessionStart is the only mint" invariant prose (see Acceptance) in
the same change, forward-facing and revised in place.

### Investigation targets

**Required** (read before coding):
- src/reducer.ts:6224-6291 — the UserPromptSubmit arm; exact seed placement (after the `:6243` killed-task break, before the `:6268` UPDATE)
- src/reducer.ts:6104-6222 — SessionStart `INSERT … ON CONFLICT(job_id)` mint; the column + conflict-target template (the seed is its minimal subset; do NOT copy the `pending_dispatches` discharge at :6210-6219)
- src/reducer.ts:6757-6777 — backend-coords fold (enriches the seeded row) AND the stale ":6757-6758 SessionStart, the only mint, fires first per session" comment to correct
- src/reducer.ts:6820-6859 — post-switch title rule (seeds title onto the present row)
- src/db.ts:579-611 — jobs schema: created_at/updated_at NOT NULL (supply event.ts), cwd/pid/last_event_id nullable, state DEFAULT 'stopped', array/count cols carry DEFAULTs — the minimal seed is schema-valid
- test/reducer-lifecycle.test.ts:468-479 — the re-fold determinism byte-compare pattern (snapshot SELECT * ORDER BY job_id + cursor, DELETE FROM jobs, reset reducer_state last_event_id=0, drainAll, assert equality) to clone for a fork-shaped stream

**Optional** (reference as needed):
- src/seed-sweep.ts:202-259 and src/exit-watcher.ts:470-498 — reaper paths; the `pid != null` guard keeps the seed out of the pidless-reap; a real-pid + NULL-start_time row is the existing "loose pid-only match" both already handle
- src/daemon.ts:1907 — TranscriptTitle is daemon-synthesized with NULL pid (why a broad first-sight mint would create reapable ghost rows, and why the guard is on pid)
- src/derivers.ts:292 — isKilledTaskNotification (total; already called in this arm before the seed)

### Risks

- **Sacred fold / re-fold determinism:** the seed MUST read only `event.session_id`/`event.ts`/`event.cwd`/`event.pid`/`event.id` — never wall-clock, env, fs, or process liveness. A from-scratch re-fold must reproduce the minted row byte-identically.
- **Blast radius:** every solo-`UserPromptSubmit` test (no prior SessionStart) now mints a row. A prior audit found NO test that asserts "no jobs row" after a lone UPS (every `getJob("ghost")).toBeNull()` is fed by SessionEnd/Notification/UsageDeleted, not UPS) — but re-verify exhaustively across ALL test files before landing.
- **Rejected alternative:** a broad `ensureJobRow` at the top of `projectJobsRow` (mint on first sight of any event) was rejected — it would mint NULL-pid rows from synthetic `TranscriptTitle` (src/daemon.ts:1907) that the reapers immediately kill.

### Test notes

Add to `test/reducer-lifecycle.test.ts` (clone existing helpers; `insertEvent` defaults an omitted pid to 4242, so pass `pid: null` to hit the guard-skip path):
1. Fork happy path: `TranscriptTitle` then `UserPromptSubmit` (pid + cwd + backend coords), no `SessionStart` → assert a jobs row exists, `state='working'`, `created_at` and `active_since` == UPS ts, pid/cwd/backend coords landed, title lands if the UPS/title carries `session_title`.
2. Re-fold determinism byte-compare over that fork-shaped (UPS-only) stream (clone :468-479).
3. Negative: a `UserPromptSubmit` with `pid: null` mints NO row.
4. Negative: a killed-task-notification `UserPromptSubmit` (isKilledTaskNotification true) mints NO row; a `TranscriptTitle`-only stream mints NO row.
5. Later `SessionStart` after a UPS-minted fork → ON CONFLICT hydrates pid/start_time/config_dir, plan_verb/plan_ref stay NULL, `pending_dispatches` is NOT discharged.
Gate: `bun test` (fast) then `bun run test:full` (mandatory — reducer/fold path) before landing.

## Acceptance

- [ ] A fork-shaped stream (UserPromptSubmit with a pid, no SessionStart) mints a jobs row: state='working', created_at == active_since == UPS ts, pid/cwd landed; title + backend coords land from subsequent title/backend-bearing events.
- [ ] A UserPromptSubmit with NULL pid mints NO row; a killed-task-notification UPS mints NO row; a TranscriptTitle-only stream mints NO row.
- [ ] A later real SessionStart for a UPS-minted fork hydrates pid/start_time/config_dir via ON CONFLICT, leaves plan_verb/plan_ref NULL, and does NOT discharge pending_dispatches.
- [ ] Re-fold determinism: a from-scratch re-fold of a fork-shaped stream reproduces byte-identical jobs rows (cloned :468-479 pattern).
- [ ] The seed uses `ON CONFLICT(job_id) DO NOTHING`, is guarded by `event.pid != null`, and reads only event fields (no wall-clock/env/fs/liveness).
- [ ] Stale "SessionStart is the only mint" invariant prose corrected, forward-facing and in place, in src/reducer.ts (:6757), CLAUDE.md, README.md, and docs/exec-backend.md.
- [ ] `bun test` green; `bun run test:full` green before landing.

## Done summary
Mint a standalone jobs row for a forked session on its first pid-bearing UserPromptSubmit (ON CONFLICT DO NOTHING, pid != null guard), so claude --fork-session sessions become normal jobs visible to the board and restore.json; a later real SessionStart hydrates via ON CONFLICT without discharging pending_dispatches. Corrected the stale single-mint invariant prose in reducer + exec-backend docs.
## Evidence
