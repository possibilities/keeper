## Description

**Size:** S
**Files:** src/daemon.ts, test/daemon.test.ts

### Approach

Scope the stage-3 human-notify classifier to the current block instance so stale rows from a resolved instance can neither suppress nor prematurely fire the page for a re-block — required even with autoclose on, since a killed window leaves its jobs row behind. `resolveEscalationJobsFor` gains an instance parameter and `escalation_instance` in its SELECT (it currently selects five columns) and in the Job shape it returns; the match predicate is `escalation_instance = ?instance OR escalation_instance IS NULL` — NULL-stamped rows (the corroboration-miss edge) are conservatively included so a stamp-missed session can still classify rather than wait forever. Thread the instance from both callers: the unblock stage-3 sweep passes the latch's `blocked_since`; the deconflict sweep passes the sticky row's `instance_event_id`. A NULL caller-side instance (legacy pre-migration rows) falls back to the unscoped verb+ref match.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/daemon.ts:2011 — resolveEscalationJobsFor, the SELECT to widen and parameterize
- src/daemon.ts:8566 — unblock stage-3 caller (latch context in scope)
- src/daemon.ts:8368 — deconflict stage-3 caller (sticky-row context in scope)
- src/daemon.ts:1979 — classifyEscalationOutcome as task 1 left it

**Optional** (reference as needed):
- test/daemon.test.ts:5260-5335 — classifier suites to extend with cross-instance cases

### Risks

- SQL `= NULL` matches nothing — the NULL-inclusive predicate must be explicit, and the NULL-caller fallback branch must be its own tested path, or stage-3 silently waits forever on legacy rows.

### Test notes

Cross-instance case: stale stamped rows from resolved instance A (killed or stopped) must not suppress or trigger instance B's classification; NULL-stamped row included; NULL caller instance falls back unscoped.

## Acceptance

- [ ] A re-blocked task's stage-3 classification sees only rows stamped with its current instance (plus NULL-stamped rows); stale resolved-instance rows neither page prematurely nor suppress
- [ ] Both callers thread their instance anchor; a NULL caller instance falls back to the unscoped match
- [ ] Existing single-instance classifier behavior is unchanged (suites green)

## Done summary

## Evidence
