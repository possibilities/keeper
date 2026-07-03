## Description

**Size:** M
**Files:** src/reducer.ts, src/reconcile-core.ts, src/autopilot-worker.ts, src/dispatch-failure-key.ts, test/ (fold + reconcile + key tests)

### Approach

Detect and break the churn loop. Detection is cause-agnostic and fold-safe: a key whose job
binds and reaches a terminal state within a short lifetime (from event ts deltas — mirror
the never-bound breaker's shape at its reducer home) increments a consecutive-instant-death
count; at threshold (3), the readiness verdict for that key flips to a blocked/sticky state
with a new collision-free reason (e.g. instant-death-breaker), emitted through the
DispatchFailed change-gate, cleared only by retry_dispatch (which resets the count). Layer
two: when >=K distinct keys trip within a window, surface a board-wide needs-human signal
whose text names the likely cause ("repeated instant worker deaths — possible session/quota
wall; resume with retry after the limit resets") — signal only, no auto-pause of the whole
board (the per-key breakers already stop the burn; a global pause is the operator's call).
Re-fold determinism: counts derive from event ts ordering only; refold-equivalence green.

### Investigation targets

**Required** (read before coding):
- src/reducer.ts NEVER_BOUND_REASON breaker (around :4181) — the shape, threshold, and clear path to mirror
- src/autopilot-worker.ts:922-945 change-gate + how readiness verdicts consume dispatch_failures
- src/dispatch-failure-key.ts display rules — add the new reason without prefix collisions
- tonight's fn-1083.2 job rows (jobs table, 19:0x-19:3x) — the real timing signature to threshold against

### Risks

- Threshold too tight catches legitimately-fast task completions — instant-death means terminal WITHOUT a done stamp; a fast successful task never trips it. Encode that guard explicitly.
- Do not touch exec-backend.ts (reserved by the dissolution epic this session); no transcript parsing.

### Test notes

Fold tests: 3 instant deaths → breaker verdict; done-stamped fast completion → no trip; retry clears; refold-equivalence. Reconcile test: tripped key not re-dispatched.

## Acceptance

- [ ] Per-key breaker trips at threshold, visible sticky, retry-clears; fast successful tasks never trip
- [ ] Board-wide multi-key signal names the quota-wall hypothesis; no global auto-pause
- [ ] Change-gate routed; refold-equivalence + both suites green

## Done summary

## Evidence
