## Description

**Size:** M
**Files:** src/reducer.ts, test/reducer.test.ts

### Approach

`src/reducer.ts` exports:
- `applyEvent(db, event)` — folds ONE event into `jobs` AND advances `reducer_state.last_event_id`, **both in the same `BEGIN IMMEDIATE` transaction** (exactly-once-per-event invariant: a crash mid-fold rolls back both the projection write and the cursor advance, so boot drain re-folds idempotently).
- `drain(db, batchSize = 200)` — `SELECT * FROM events WHERE id > (SELECT last_event_id FROM reducer_state WHERE id=1) ORDER BY id LIMIT ?`, fold each row via `applyEvent`, return count drained. Caller loops until `drain()` returns 0.

State machine (descendant of `hooks-tracker.py:867-1069`, heavily stripped — DROP all prise / harness / lineage / name-scraping logic):

| event.hook_event | jobs action | guard |
|---|---|---|
| `SessionStart` | `INSERT OR IGNORE INTO jobs (job_id, created_at, cwd, pid) VALUES (?,?,?,?)` where `job_id = session_id` | always |
| `UserPromptSubmit` | `UPDATE jobs SET state='working' WHERE job_id=? AND state != 'ended'` | sticky 'ended' |
| `Stop` | `UPDATE jobs SET state='stopped' WHERE job_id=? AND state != 'ended'` | sticky 'ended' |
| `SessionEnd` | `UPDATE jobs SET state='ended' WHERE job_id=?` | always; sticky |
| any (when payload has `data.permission_mode`) | `UPDATE jobs SET mode=? WHERE job_id=?` (`'plan'`→`'plan'`, anything else→`'act'`) | always |
| all others (PreToolUse, PostToolUse, PostToolUseFailure, Notification, SubagentStart, SubagentStop) | no jobs write | always advance cursor |

After any jobs write: `UPDATE jobs SET last_event_id=?, updated_at=? WHERE job_id=?`.

**Edge cases (locked, do not surface as questions):**
- **Terminal event without prior SessionStart**: `UPDATE jobs WHERE job_id=?` matches zero rows. No-op. Cursor still advances. Correct.
- **Duplicate SessionStart for same session_id**: `INSERT OR IGNORE` no-ops. Correct.
- **Unknown event_type** (forward-compat): falls through "all others" — cursor advances, no jobs write. Correct.
- **Malformed event row** (JSON parse fails on `data` blob when needed): catch, log to stderr, advance cursor (skip-and-log). Never halt the reducer.
- **`data_version` bumped by VACUUM / WAL checkpoint** (no new event rows): `drain()` returns 0, no-op. Correct.

### Investigation targets

**Required** (read before coding):
- `/Users/mike/code/arthack/apps/hookctl/hooks/hooks-tracker.py:867-1069` — `_maintain_job_state` outline (READ FOR STRUCTURE; reject everything prise-, harness-, lineage-, and name-scraping-related)
- `/Users/mike/code/arthack/apps/hookctl/hooks/hooks-tracker.py:1170-1230` — UserPromptSubmit/Stop state transitions

**Optional** (reference as needed):
- Brief's reducer logic spec (in the sketch bundle ride-along)

### Risks

- The "exactly once per event" invariant depends on cursor advance + jobs write being in the SAME transaction. Tests must explicitly verify this — e.g., simulate a mid-fold throw and assert the cursor did NOT advance.
- Reducer must use the writer connection. The wake worker's read-only connection MUST be separate (see task 5) or `data_version` polling silently breaks.
- `drain()` should NOT hold the writer lock longer than the batchSize loop — keep transactions short to avoid blocking hook inserts.

### Test notes

- Per-transition tests (one test per row in the table above), in-memory DB or tmp path with `--isolate`.
- Idempotency test: process N events, snapshot `jobs` + cursor. Process again. Assert same final state.
- Sticky-ended test: SessionEnd, then UserPromptSubmit. State stays `ended`.
- Terminal-without-start test: SessionEnd for unknown session_id. No row created. Cursor advances.
- Mode-flip test: SessionStart, then event with `data.permission_mode='plan'`, then event with `permission_mode='acceptEdits'`. Final `mode='act'`.
- Crash-mid-fold test: throw inside `applyEvent` between jobs write and cursor advance (mock), assert tx rolled back (cursor unchanged).

## Acceptance

- [ ] `applyEvent` folds one event in a single `BEGIN IMMEDIATE` transaction with cursor advance
- [ ] `drain(batchSize)` consumes events `id > cursor` in batches; idempotent on re-run
- [ ] All 4 state transitions (Start/UPS/Stop/End) work and sticky-`ended` is enforced
- [ ] `mode` updates from `data.permission_mode` on any event
- [ ] Unknown/no-op event types advance the cursor without touching jobs
- [ ] Malformed event row logs to stderr and advances cursor (does not halt)
- [ ] Test suite covers every transition above + idempotency + crash-mid-fold rollback

## Done summary

## Evidence
