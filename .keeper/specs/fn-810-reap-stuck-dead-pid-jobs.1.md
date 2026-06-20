## Description

**Size:** M
**Files:** src/exit-watcher.ts, test/exit-watcher.test.ts (or test/daemon.test.ts), README.md, CLAUDE.md

### Approach

Add a periodic re-probe sweep to the exit-watcher worker: on a slow tick
(~60s), scan the candidate rows it already tracks (`state IN
('working','stopped')`), and for each pid-bearing row older than the
launch-race age gate (`created_at` >= 5 min, mirroring the sitter's
`STUCK_JOB_MIN_AGE_SECS`) probe liveness with the existing
`kill(pid,0)`/ESRCH pattern plus the recycled-pid start_time mismatch
check. On confirmed dead/recycled, post the SAME `ExitMessage` shape the
kernel arm posts — main's existing onmessage handler (re-read, terminal
guard, `(pid,start_time)` match, `insertEvent` + `pumpWakes`) mints the
synthetic `Killed` unchanged. Structure the predicate as a pure exported
function `(rows, nowSecs, isAlive, readStartTime) => candidates` so tests
drive it clause-by-clause. Probe failure or null start_time = leave alone
(mirror seedKilledSweep's conservatism). Per-row try/catch so one bad
probe never aborts the sweep; single observation suffices (ESRCH is
authoritative on Darwin). Log one stderr line per reap with
`(jobId, pid, start_time, reason)`.

### Investigation targets

**Required** (read before coding):
- src/exit-watcher.ts — candidate-row tracking, `ExitMessage` shape, pidless-reap path, worker lifecycle (`shutdown` message, exit codes)
- src/seed-sweep.ts:25-67 — the predicate spec (Q7 rules: dead, recycled, null-pid handling)
- src/seed-sweep.ts:97 — `readOsStartTime` (recycle probe, 500ms ps timeout, null-on-failure)
- src/daemon.ts:2214-2300 — main's onmessage mint: confirm the re-probe's message reuses this path with zero main changes
- src/reducer.ts:6195-6255 — the `Killed` fold terminal guard + `(pid,start_time)` match (the CAS; do not touch)

**Optional** (reference as needed):
- src/reaper-worker.ts:143,255 — pure-predicate + pre-act TOCTOU re-check archetype
- sitters/performance/watch.ts:305-307,684 (sitter repo) — `STUCK_JOB_MIN_AGE_SECS`, `NON_TERMINAL_JOB_STATES`, the external predicate being internalized
- test/daemon.test.ts:1190-1309 — `seedJobsRow`/`pickDeadPid` helpers for live-DB integration tests

### Risks

- A resume between probe and fold: covered by the fold-time `(pid,start_time)`
  mismatch no-op — do not add a second mint path or direct UPDATE.
- `updated_at` is NOT a valid age key (reset by late git-count/title/monitor
  writes on stopped rows); the age gate keys on `created_at` by design —
  the dead-pid conjunct carries correctness.
- Do not add a third raw `INSERT INTO events` site; the message-to-main
  path keeps the column list in one place.

### Test notes

Pure-predicate tests clause-by-clause (age boundary off-by-one, dead pid,
recycled start_time, null pid handling/ownership, probe-failure
leave-alone) with injected `now`/`isAlive`. One live-DB integration test:
seed a stopped row with a dead pid (pickDeadPid), drive the sweep, assert
the row folds to `killed` and a re-sweep is a no-op.

## Acceptance

- [ ] Pure predicate exported and covered clause-by-clause (age gate boundary, dead, recycled, null start_time, probe failure)
- [ ] Stopped row with dead pid + age >= gate folds to `killed` via the existing onmessage mint path; main's handler unchanged or minimally extended
- [ ] Fresh row (< age gate) with dead pid is NOT reaped
- [ ] Re-sweep of an already-killed or re-armed row is a no-op
- [ ] One stderr log line per reap with jobId, pid, start_time, reason
- [ ] README synthetic-Killed producer enumeration + dead-pid mechanisms prose updated; CLAUDE.md one-line reap-mechanism pointer added

## Done summary
Added a periodic dead-pid re-probe (reprobeLoop, ~60s) to the exit-watcher: a pure selectDeadReprobeCandidates predicate (age-gated on created_at >= 5 min) mints a synthetic Killed via the existing kernel-arm ExitMessage path for any non-terminal job whose worker pid is verifiably dead or recycled, with main's verifier and the Killed fold unchanged.
## Evidence
