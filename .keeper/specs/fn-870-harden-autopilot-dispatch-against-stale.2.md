## Description

**Size:** S
**Files:** src/readiness.ts, src/readiness-client.ts, src/autopilot-worker.ts, test/readiness.test.ts, test/autopilot-worker.test.ts

### Approach

Defense-in-depth: a `pending_dispatch` past a hard ceiling must not count as a
root-occupant toward the dispatch budget/mutex, so a stale launch window can't
starve real dispatch even in the window before the TTL sweep clears it. Thread
`dispatched_at` into the `PendingDispatch` occupant (`src/readiness.ts:268`,
today `{verb,id,dir}`) via `projectPendingDispatches`
(`src/readiness-client.ts:460`), and exclude a pending from occupancy when
`dispatched_at` is older than a HARD ceiling distinctly longer than
`PENDING_DISPATCH_TTL_MS` + the sweep cadence (use 2× TTL = 240s) so the
exclusion is a pure last-resort backstop that never opens a double-dispatch
window (the 60s sweep always clears first). Gate on the producer-injected `now`
(`src/readiness.ts:302`, default `-Infinity`) EXACTLY like `SUBAGENT_STALENESS_SEC`
so re-fold/simulator byte-identity holds (a phantom is never "expired" under
`-Infinity`).

### Investigation targets

**Required** (read before coding):
- src/readiness.ts:268 `PendingDispatch` type, :302 injected `now` (default `-Infinity`), :931/:943 dispatch-pending verdict + `isRootOccupant`, :419-428 `fallbackRoots` mutex seed.
- src/readiness-client.ts:460 `projectPendingDispatches` (the SOLE builder for the reconciler AND `subscribeReadiness` — both must agree on the cutoff).
- src/autopilot-worker.ts:878-891 occupied/budget.
- the existing `SUBAGENT_STALENESS_SEC` now-gated occupant — copy that determinism-safe pattern.

### Risks

- Double-dispatch if the ceiling is too short (excludes a row the sweep hasn't released, then re-dispatch + the sweep's expire collide) — the 2×TTL ceiling avoids this.
- The reconciler and the board viewer (`subscribeReadiness`) must use the same cutoff or occupancy display drifts from dispatch behavior.

### Test notes

`bun run test:full`. Assert: a fresh pending counts toward budget; a >2×TTL pending does not; default `-Infinity` keeps existing readiness tests byte-identical.

## Acceptance

- [ ] A `pending_dispatch` older than the hard ceiling (2× `PENDING_DISPATCH_TTL_MS`) is excluded from `occupied`/budget and the per-root mutex
- [ ] The exclusion is `now`-gated (default `-Infinity` = no-op) so existing readiness/simulator tests stay byte-identical
- [ ] reconciler + `subscribeReadiness` share one cutoff; `bun run test:full` green

## Done summary

## Evidence
