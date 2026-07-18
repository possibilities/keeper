## Overview

Three launch-chain guarantees: a provider constraint plus selected cell must
resolve to a routable, launchable worker manifest before any launch fires (a
mis-classified or unlaunchable pair mints a visible sticky instead of a doomed
wrapped launch); dispatched workers never park silently on interactive first-run
gates — the launcher pre-seeds workspace trust for the target repo into the
resolved account config before spawn; and a launch that still parks (pending row
bound to no session past a grace) mints a visible, self-clearing distress naming
the tmux window instead of the silent re-serve loop.

## Quick commands

- bun test ./test/worker-cell.test.ts && bun test ./test/agent-launch-config.test.ts && bun test ./test/autopilot-worker.test.ts
- bun run typecheck && bun run lint

## Acceptance

- [ ] An impossible provider-constraint + cell pair (unlaunchable manifest OR wrapped marker on a route-less model) never launches: it mints a sticky dispatch failure naming the pair, cleared only by retry
- [ ] A dispatch into a repo new to the resolved account config does not prompt for workspace trust — the launcher pre-seeds both trust flags for the launch cwd before spawn
- [ ] A launch parked pre-SessionStart past its grace mints a distress naming its window/pane, suppresses further silent re-serves, self-clears on a late bind, and the window is left open for inspection
- [ ] A new ADR records the producer gate ownership, the parked semantics, and the provider-constraint vocabulary; CONTEXT.md defines provider constraint and parked-launch without colliding with the existing pin/parked senses

## Early proof point

Task ordinal 1 proves the producer gate: the fn-1325.2 replay fixture (provider
constraint + native-only cell) must produce the sticky, not a launch. If the
mis-classification case cannot be distinguished at the producer: gate on
launchability alone and record the residual in the ADR.

## References

- src/reconcile-core.ts:2438-2536 — launch compose; wrapped marker set at :2502 off isWrappedCell alone
- src/worker-cell.ts:487 resolveWorkerCell + :550-589 providerRejectReason — THE validation seam to extend, never parallel
- src/autopilot-worker.ts:4927-5008 — producer pre-launch re-run + assertNever reject switch; :4318 confirmRunning 60s ceiling; ceiling(60)<TTL(120)<cooldown(200) ordering is load-bearing
- src/daemon.ts:12429-12519 pending-dispatch sweep; db.ts:5843-5896 never-bound K=3 fold
- src/agent/main.ts:2930-2977 route selection (knows slot + target repo — the pre-seed point); src/account-router.ts:46 RouteSelection carries no config dir today
- Birth records are pi-leg-only (src/agent/main.ts:3267) — a parked wrapped-claude wrapper leaves NO birth record; the pending row + Dispatched payload is the presence signal
- Epic deps: none (sole open epic is dotfiles-only). The account-* files carry foreign uncommitted edits — commit-work ownership + the cooperative release rail govern any contact

## Docs gaps

- **docs/adr/ (new record, next provisional)**: producer-owned launchability gate, parked-launch semantics, provider-constraint vocabulary; relates to ADR 0079 and the worker_provider lineage
- **docs/problem-codes.md**: parked-launch distress row + the new reject reason consolidated into the worker-provider family section, no near-duplicates
- **CONTEXT.md**: provider constraint + parked-launch entries with Avoid lines, reconciling the existing rejected "pin" sense

## Best practices

- **Seed trust and permissions together** — allow-lists are silently ignored in an untrusted workspace; absolute realpath keys only
- **Admission-time two-layer validation** (shape, then joint feasibility) with a cheap producer re-check at spawn
- **A no-output timeout cannot classify a stall** — the distress names the window for a human, never asserts the cause
- **Never widen dangerous permission bypasses as a trust workaround**
