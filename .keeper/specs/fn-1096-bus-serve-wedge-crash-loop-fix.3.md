## Description

**Size:** S
**Files:** src/notadb-tolerance.ts, src/plan-worker.ts, src/exit-watcher.ts, src/git-worker.ts, test/notadb-tolerance.test.ts, README.md, CLAUDE.md

### Approach

Land the filed-but-unimplemented fix from the serve-wedge finding doc: a transient
SQLITE_NOTADB ("file is not a database") on a read-only PRAGMA data_version poll is a
boot-checkpoint view race, not corruption — today it propagates, crashes the worker, and
fatalExits the daemon. Build one shared helper (new dep-free module) that wraps a poll read:
classify NOTADB as transient, skip the tick, count consecutive misses, reset on success, and
after a bounded run of consecutive misses (~20) RETHROW so genuine persistent corruption still
reaches the existing crash-to-restart path — tolerance must never become an infinite silent
skip. Emit a rate-limited backstop-telemetry record per skip so occurrences stay countable.

Adopt the helper at all three poller sites without changing their loop shapes (setInterval,
sleep-loop, sweep tick) or their autocommit invariant (naked PRAGMA, never inside an open
BEGIN). While adopting, sweep for any sibling data_version poller the enumeration missed.

Docs in the same change: revise the CLAUDE.md data_version invariant line in place to carry
the skip-tick rule; correct the README System-map/boot-gates poller enumeration to name the
actual three pollers.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/plan-worker.ts:3759-3781 — dbPollTimer poll + the autocommit no-BEGIN comment
- src/exit-watcher.ts:206-217 — sleep-loop poll shape
- src/git-worker.ts:2463 — dataVersionQuery.get() sweep-tick shape
- src/backstop-telemetry.ts — record/rate-limiter API for the skip counter

**Optional** (reference as needed):
- ~/docs/2026-07-02-fn-1082-2-serve-wedge-finding.md — Part 2, the mechanism + blast-radius analysis
- CLAUDE.md process-invariants block; README System map — the two doc lines to revise

### Risks

- Swallowing too much: keep the tolerated set to NOTADB (and at most SQLITE_BUSY if observed
  at these sites); any other SqliteError still throws immediately.

### Test notes

Unit-test the helper with an injected reader that throws NOTADB in scripted patterns
(single transient, alternating, N-consecutive rethrow, unrelated-error passthrough).
freshMemDb for any real-connection smoke.

## Acceptance

- [ ] A transient NOTADB during a data_version poll skips that tick without crashing any of the three workers, and polling resumes on the next tick
- [ ] A bounded run of consecutive NOTADB failures rethrows — no infinite silent skip
- [ ] All data_version pollers route through the shared helper; no ad-hoc per-site catch remains
- [ ] Skips are countable via backstop telemetry
- [ ] bun test green; the CLAUDE.md and README lines state the new behavior

## Done summary

## Evidence
