## Description

Operators currently detect ingest starvation only by hand-querying
events-MAX age against wall clock, and a watchdog kill names its detector
but never its cause. Surface both: status carries the newest-folded-event
age; a sustained ingest stall with unread backlog mints a bounded
distress signal; and a lag-breach streak at or past 3 logs ONE bounded
line naming the maintenance pass (or other attributed work) active during
the breach window.

## Acceptance

- `keeper status --json` carries an ingest-lag field (newest-folded-event
  age in seconds) with a test pinning its derivation; the field reads 0
  or near-0 on a current projection fixture and the true lag on a stale
  one.
- A distress signal mints when ingest applies stall past a bounded
  threshold with unread events-log backlog present, and level-clears when
  ingest catches up (deterministic tests for mint and clear; no new
  unbounded projection state).
- On a lag-breach streak reaching 3, exactly one bounded log line names
  the active maintenance pass; a test drives the streak with a stubbed
  active-pass marker and asserts the single line.

## Done summary

## Evidence
