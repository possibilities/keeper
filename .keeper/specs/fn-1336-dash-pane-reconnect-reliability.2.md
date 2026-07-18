## Description

**Size:** M
**Files:** src/readiness-client.ts, test/readiness-client.test.ts

### Approach

Red-repro first: under the injected socket factory + fake clock, reproduce a
permanently-dead client and NAME the wedge — the two verified candidates are
(a) triggerReconnect's reconnecting latch sticking because self-terminate
never re-drives the close callback (the latch's only reset), and (b) the
retry loop parked forever in an unbounded connect dial (no connect-timeout
exists, and panes pass no give-up policy). The injected seam must faithfully
model terminate-that-does-not-emit-close — a mock whose fallback always
synthesizes close cannot express the bug. Then harden recovery
UNCONDITIONALLY: triggerReconnect guarantees a scheduled reconnect even when
close never fires (belt-and-suspenders), a hand-rolled connect-timeout
(injected timers; above the backoff base, at most the query timeout) routes
a hung dial to teardown-and-retry, never fatal; every teardown path stays
hard-destroy so the flat-RSS soak stays green; the give-up path that
keeper-await relies on is untouched. Touch the heartbeat/query-timeout
detection thresholds ONLY if the repro proves a false-positive teardown of a
live-but-slow socket; otherwise leave detection alone. Record which wedge
state reproduced (or the null result) in Evidence.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/readiness-client.ts:1105-1133 triggerReconnect + pollAll heartbeat; :1461-1520 teardown/destroy; :1522-1570 connectOnce + close handler; :1641-1669 connectWithRetry await; :938-987 give-up wiring (inert for panes); :160-221 constants
- scripts/subscribe-bounce-soak.ts — the flat-RSS gate that must stay green

**Optional** (reference as needed):
- test/readiness-client.test.ts — the injected connect-factory/fake-now idioms to extend

### Risks

- A recovery regression here hits every pane, keeper await, and the dash — the shared-client blast radius is the whole TUI surface
- A mock that always emits close validates the fix against a harness that cannot express the bug

### Test notes

Red: terminate-without-close leaves the client dead today; hung dial parks
the loop today. Green: both recover under the fix; attempt counter resets on
served result; give-up policy still honored when passed; a thrown lifecycle
callback does not kill the loop (bound the blast radius or record why not).

## Acceptance

- [ ] A red test reproduces (or records the null result for) each candidate wedge under a seam that models terminate-without-close
- [ ] The hardened client schedules a reconnect without the close callback and bounds every connect dial, routing timeouts to retry, never fatal
- [ ] Every teardown remains hard-destroy and the subscribe-bounce soak stays flat
- [ ] Detection thresholds are unchanged unless the repro proved false-positive teardown, with the verdict recorded in Evidence
- [ ] The readiness-client test gate passes

## Done summary

## Evidence
