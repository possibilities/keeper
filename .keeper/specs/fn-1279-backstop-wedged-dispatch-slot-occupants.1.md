## Description

Originating finding F1 (evidence path: `src/session-activity.ts:222` returns
`{status:"unknown", reason:"resource-evidence-stale"}` for a stopped+alive session
whose `has_live_worker_monitor` snapshot ages past `HARNESS_RESOURCE_STALE_SEC`;
the old `MONITOR_RELEASE_SEC` force-release ceiling is deleted, confirmed by
`test/readiness.test.ts:2831` asserting `running({kind:"monitor-stale"})` still
occupies at age 2000s > the former 1800s ceiling; `src/autopilot-worker.ts`
stuck-sentinel escalation keys only on the `cwd-missing` case). Net: a genuinely
abandoned but pid-alive worker wedges its per-root dispatch mutex indefinitely with
only a passive `monitor-stale` board flag and no active recovery.

Add an operator-visible backstop in the autopilot producer that mints exactly one
`needs_human` escalation (page-once, producer-level-cleared — same discipline as the
existing sticky distress rows) for a per-root dispatch slot held by a
permanently-`unknown` (`resource-evidence-stale`) monitor occupant past a bounded
threshold. PAGE, never force-release or kill — preserve the epic's "age never proves
terminality" thesis. Clear the escalation on positive evidence only (occupant settles
to active, pid exits, or the fact clears).

Files: `src/autopilot-worker.ts` (producer escalation + page-once level-clear),
`src/session-activity.ts` / `src/readiness.ts` (surface the long-unknown occupant
signal to the producer as needed), `test/readiness.test.ts` (assert the page-once
escalation fires and clears; assert no force-release).

## Acceptance

- [ ] A stopped+alive session whose worker-monitor stays `resource-evidence-stale`
      past the threshold raises one `needs_human` escalation for the wedged per-root
      slot; a re-page happens only after a producer level-clear.
- [ ] The backstop never force-releases or kills the occupant; a fresh or
      within-threshold monitor occupant is unaffected.
- [ ] The escalation clears on positive settle/exit evidence.

## Done summary

## Evidence
