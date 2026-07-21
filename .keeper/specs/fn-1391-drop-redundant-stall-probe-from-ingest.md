## Overview

The events-ingest stall-distress step (a readdir + per-file statSync + per-file
SELECT backlog probe) runs from BOTH the watcher onmessage handler after every
live ingest AND the 3s fallback timer. Since a stall is by definition the
absence of ingest, only the timer can ever mint the distress, so the onmessage
invocation is redundant main-thread fs+DB overhead on the exact path this epic
exists to keep responsive. This follow-up removes that hot-path redundancy while
preserving stall detection on the fallback cadence.

## Acceptance

- [ ] The events-ingest stall-distress probe no longer runs on the per-message watcher hot path; stall mint/clear still works on the fallback timer cadence.
- [ ] Stall-distress mint and clear behavior is unchanged from the audited feature (proven by the existing/added deterministic tests).

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | daemon.ts:12787 runs the stall probe on the watcher onmessage hot path; only the 3s fallback timer (17339) can mint a stall, so the hot-path call is redundant fs+DB overhead. |
| F2 | culled | — | probeEventsLogBacklog:7510 uncached db.prepare is a minor optimization, moot once F1 moves the probe off the hot path. |
| F3 | culled | — | withActiveMainWork:10036 label misattribution is diagnostic-log-only under rare non-LIFO pass overlap; activeWorkThisLagWindow fallback already covers the likely window. |
| F4 | culled | — | test helper foldedEventFreshnessAgeMs is a naming nitpick with no behavior impact. |
| F5 | culled | — | Test Gap for cross-tick secondary-surface resume is self-rated low value; unit-level deferral already covered. |

## Out of scope

- The uncached db.prepare in probeEventsLogBacklog (F2) — immaterial once the probe runs only on the 3s timer.
- The busy-lag attribution label overlap imperfection (F3) and the test-helper unit naming (F4).
- The inferred cross-tick secondary-surface resume test gap (F5).
