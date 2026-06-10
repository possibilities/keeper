## Description

**Size:** S
**Files:** src/readiness-client.ts, test/readiness-client.test.ts (or the existing readiness-client lifecycle test file)

### Approach

Make the board / CLI readiness view agree with the reconciler in armed
mode, so a row reads the same way the daemon actually schedules it (the
armed epic shows `[ready]`, an unarmed slot-loser shows blocked). This is
display-only — the deadlock is already fixed server-side by task 1; this
task removes the board≠dispatch divergence.

1. Subscribe the readiness client to TWO new projections: `autopilot_state`
   (for `mode`) and `armed_epics` (the presence set) — mirroring
   `loadReconcileSnapshot` (autopilot-worker.ts:1876-1904), including the
   default mode `'yolo'` when `autopilot_state` is empty.
2. Widen the first-paint gate (readiness-client.ts:~57-60) to include the
   two new collections so the board doesn't paint a pre-armed-state frame.
3. Import `computeEligibleEpics` (armed-closure.ts) into the client, compute
   the eligible set per snapshot when mode is `armed` (else `undefined`),
   and pass it as the new trailing param to `computeReadiness` at ~1736.
4. Cover reconnect/teardown for the two new subscriptions (the client has
   an established lifecycle pattern from fn-609/fn-610).

### Investigation targets

**Required** (read before coding):
- src/readiness-client.ts:1736-1752 — the board `computeReadiness` call site
- src/readiness-client.ts:1556-1613 — the five-collection subscribe block (where to add the two)
- src/readiness-client.ts:57-60 — the first-paint gate to widen
- src/autopilot-worker.ts:1876-1904 — the canonical mode/armed projection read to mirror (default `'yolo'`)

**Optional** (reference as needed):
- src/armed-closure.ts:52-99 — `computeEligibleEpics`

### Risks

- Forgetting to widen the first-paint gate → board paints a frame with no mode/armed data and briefly shows the wrong winner on reconnect.
- Diverging the empty-`autopilot_state` default from the reconciler's `'yolo'` → board and daemon disagree.

### Test notes

Extend the readiness-client lifecycle test: armed mode with a shared-root
pair surfaces the same winner the reconciler picks; reconnect re-primes the
two new subscriptions; empty `autopilot_state` defaults to yolo (no eligible
filtering). This file is process/lifecycle-shaped → covered by `test:full`.

## Acceptance

- [ ] Readiness client subscribes to `autopilot_state` + `armed_epics`; first-paint gate waits on both.
- [ ] Board computes the eligible set (mirroring the reconciler, default `'yolo'`) and passes it to `computeReadiness`.
- [ ] In armed mode the board shows the same per-root winner the reconciler dispatches.
- [ ] Reconnect/teardown covered; empty `autopilot_state` → yolo (no filtering).
- [ ] `bun run test:full` green.

## Done summary

## Evidence
