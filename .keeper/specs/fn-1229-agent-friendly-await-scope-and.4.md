## Description

**Size:** M
**Files:** src/readiness-client.ts, scripts/subscribe-bounce-soak.ts, test/readiness-client.test.ts

### Approach

A long-lived await burned ~15 CPU-minutes in ~3 hours while surviving
four daemon bounces — reconnect-forever is correct (ADR 0032 keeps it),
its cost is unmeasured. Measure first: attribute steady-state CPU
between the steady-poll cadence, the catching-up backstop refetch, and
per-frame re-evaluation on a busy board, using a repeatable harness.
Fix what the measurement names — the expected shape is adaptive
level-triggered waiting (grow the idle interval on consecutive no-change
wakes, reset on activity; coalesce one eval per wake) — never a
busy-poll tighten. Then extend the bounce-soak script to assert a CPU
budget alongside its flat-RSS gate so the regression class is caught.
Do not regress reconnect-forever, the first-paint re-gate, or the
documented leak fix; keep server-up's minimal subscribe untouched.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at
authoring time, but the repo moves.*

**Required** (read before coding):
- src/readiness-client.ts:23-67 — reconnect/backoff/leak docstrine and
  the terminate-not-end fix; :140-200 poll/backoff/heartbeat constants
  (steady-poll + CATCHING_UP backstop are the prime suspects)
- scripts/subscribe-bounce-soak.ts — the flat-RSS evidence gate to
  extend with CPU
- test/readiness-client.test.ts — the mock-connect patterns for
  fast-tier interval logic tests

### Risks

- Growing idle intervals must not delay met-detection past the interval
  floor for active conditions — bound the max idle interval and reset
  on any subscribed frame
- CPU measurement on a laptop is noisy — assert a generous budget
  (order-of-magnitude), not a tight number

### Test notes

Fast-tier: adaptive-interval logic as pure functions over fake clocks
(grow/reset/cap). The CPU soak itself is script-tier evidence (not a
bun test); record before/after numbers in Evidence.

## Acceptance

- [ ] A written measurement attributes the steady-state CPU cost of a
  long-lived await and the dominant contributor is identified
- [ ] The dominant cost is reduced with adaptive level-triggered
  waiting whose interval logic is pinned by fast-tier tests (grow on
  idle, reset on activity, bounded cap)
- [ ] The bounce-soak script asserts a CPU budget alongside flat RSS
  and passes post-fix
- [ ] Reconnect-forever, first-paint re-gating, and the leak fix are
  regression-pinned green

## Done summary

## Evidence
