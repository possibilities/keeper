## Overview

The harness-lifecycle refactor deliberately removed the hard `MONITOR_RELEASE_SEC`
force-release ceiling in favor of a "age never proves terminality / fail closed"
stance: a stopped-but-alive session whose live-worker-monitor snapshot goes
permanently stale now classifies `unknown` (`resource-evidence-stale`) and keeps
occupying its per-root dispatch mutex. That is correct against false positives, but
it leaves no automated recovery and no active operator page for the genuinely
abandoned case — the slot wedges indefinitely, surfaced only as a passive
`monitor-stale` board flag. This follow-up restores an operator-visible backstop
that PAGES (never force-releases) so a wedged autopilot root recovers via a
once-per-occupant `needs_human` escalation without reintroducing the age-based
false positive the epic removed.

## Acceptance

- [ ] A stopped+alive session whose live-worker-monitor stays stale past a bounded
      threshold raises exactly one operator-visible `needs_human` escalation for the
      wedged per-root dispatch slot (page-once semantics, re-armed only on producer
      level-clear), and never force-releases or kills the occupant.
- [ ] The escalation clears positively when the occupant settles or its pid exits;
      the mutex-occupancy behavior for a fresh/within-threshold monitor is unchanged.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept   | .1 | session-activity.ts:222 makes a stopped+alive permanently-stale-monitor session occupy the per-root dispatch mutex forever (release ceiling deleted; readiness.test.ts:2831); stuck-sentinel covers only cwd-missing, so no active page frees or flags it. |
| F2 | culled | —  | restore-set.ts:617 filter change is intentional, test-covered, double-dispatch-guarded; only remedy is amending an already-written done_summary — no code, no user impact. |
| F3 | culled | —  | MONITOR_RELEASE_SEC declaration already deleted; only a dangling prose reference in collections.ts:325 remains and the 1800s value is independently justified in that same comment — cosmetic doc nit. |
| F4 | culled | —  | refuted by actual code — the fn-719 stale tests (readiness.test.ts:2811, 2831) are titled "...still occupies" and assert monitor-stale; no "RELEASED" title exists in the worktree. |

## Out of scope

- Re-introducing any age-based force-release of a live occupant (the epic deliberately
  removed the `MONITOR_RELEASE_SEC` ceiling; the backstop must PAGE, not release).
- The `cwd-missing` stuck-sentinel path, which already escalates its own case.
- Correcting task 5's done_summary wording and the dangling `collections.ts:325`
  comment reference (F2/F4/F3 — culled, not tracked here).
