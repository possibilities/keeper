## Overview

The `buildDiscoveryCandidates` fast path uses `performance.now()` as `nowMs`
(milliseconds since process start) but compares it against `jobs.updated_at`
in real unix seconds, silently making the `RECENT_JOB_WINDOW_MS` recent-window
filter always pass. The fix is a one-line call-site change (`Date.now()`) plus
a test that pins the clock-units contract.

## Acceptance

- [ ] `reconcileRoots` passes `Date.now()` (not `performance.now()`) as `nowMs`
- [ ] A test exercises the fast-path SQL cutoff with a `performance.now()`-scale `nowMs` against real `updated_at` rows, confirming the window now rejects stale entries
- [ ] All existing git-worker tests pass without modification

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F2     | kept   | .1   | Clock domain mismatch confirmed at git-worker.ts:2046/1274: performance.now() (ms since process start) vs jobs.updated_at (unix seconds) makes cutoffSec near-zero or negative, causing every job ever to match the "recent" filter. |

## Out of scope

- F1 (WATCH_DROP_DWELL_MS comment drift): pre-culled at classifier as tier_0 — comment inconsistency only, no behavioral impact
- Changing the dwell/hysteresis behavior
- Any reducer or schema changes
