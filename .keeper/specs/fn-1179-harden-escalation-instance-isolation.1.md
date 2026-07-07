## Description

Fix F1 (folding in F3's test): `resolveEscalationJobsFor` at `src/daemon.ts:2206`
builds its instance-scoped read as
`WHERE plan_verb = ? AND plan_ref = ? AND (escalation_instance = ? OR escalation_instance IS NULL)`
(line 2222). The `OR escalation_instance IS NULL` arm matches a NULL-stamped row for
EVERY non-null instance, so a corroboration-miss `stopped` row from a RESOLVED prior
instance A (never reaped, since `isEscalationCandidate` requires a non-null instance)
leaks into a later re-block instance B's stage-3 read. During B's launch window
(B's latch marked dispatched, B's own SessionStart not yet folded) the classifier
reads the stale A row as `{terminal:true, verdict:"declined"}` and pages the human for
B before B ran; `human_notified_at` then latches and suppresses B's genuine verdict.

Careful-fix constraint: the NULL fallback is INTENTIONAL (task .3 threaded it so a
genuine corroboration-miss session is still visible to its own instance). Do NOT
simply strip the NULL arm — that would orphan a legitimate miss-stamped session for a
currently-blocked instance and it would never page. Instead, prevent a PRIOR instance's
NULL row from speaking for a NEWER instance: e.g. only include a NULL-stamped row when
the caller's `instance` is itself NULL, or gate NULL-inclusion on the row's own
`plan_ref`/timing (its `blocked_since`/event anchor) so a resolved-instance miss row
cannot match a later instance. Both callers (unblock's `blocked_since` latch at
daemon.ts:8751, deconflict's `instance_event_id` sticky at daemon.ts:9001) must keep
working.

Files: `src/daemon.ts` (`resolveEscalationJobsFor` + its two call sites), plus the
escalation instance-scope test file.

## Acceptance

- [ ] A NULL-stamped `stopped` row from a resolved prior instance is excluded from a
      newer non-null instance's `resolveEscalationJobsFor` read.
- [ ] A genuine corroboration-miss session is still classified/paged for its own
      block instance (NULL-fallback intent preserved).
- [ ] Regression test: seed a NULL-instance stopped `unblock` row + scope to a
      non-null re-block instance, assert the classifier does NOT fire `declined` for
      the launch-window re-block; keep the existing non-null-stale-instance (100)
      exclusion case green.

## Done summary

## Evidence
