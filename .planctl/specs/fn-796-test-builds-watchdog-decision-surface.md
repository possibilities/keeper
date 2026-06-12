## Overview

The builds sitter's watchdog (`babysitters/builds/watchdog.ts`) is the ONLY
notification path in the whole sitter — the findings path pages nothing, so a
stale-heartbeat alarm is the sole signal the sitter has died. Its pure decision
surface ships with no dedicated test file: a wrong staleness, all-clear, or
first-run branch means a silent miss (no page when the sitter is dead) or a
spurious page. This follow-up adds the missing unit coverage to lock that surface.

## Acceptance

- [ ] `test/builds-watchdog.test.ts` exists and asserts the `decideWatchdog` branch matrix, heartbeat-read degrade, and day-marker round-trip
- [ ] The test passes under the suite that runs the `keeper-watchdog` precedent

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F2 | kept | .1 | watchdog.ts pure decision surface is the sitter's only notification path and has no dedicated test; precedent keeper-watchdog.test.ts exists, builds-watchdog.test.ts confirmed missing |
| F3 | culled | — | Auditor self-confirmed no change; watchdog.ts:249 nowSecs is a producer dep allowed by the no-clock-in-fold invariant |
| F4 | culled | — | Speculative perf gated on many-builder growth; trivially cheap at current scale, no user impact |
| F5 | culled | — | spawnAgentLive malformed-ack is a degrade-to-fallback path already covered indirectly; missing direct test has no user impact |

## Out of scope

- The `spawnAgentLive` malformed-ack direct-test gap (F5) — degrade-to-fallback, already covered indirectly
- The per-builder subquery index (F4) — deferred until buildbot scale warrants it
