## Description

**Size:** M
**Files:** src/autopilot-worker.ts, src/daemon.ts, src/reducer.ts, src/dispatch-failure-key.ts, test/autopilot-worker.test.ts, test/reducer-projections.test.ts, docs/problem-codes.md

### Approach

A launch that reaches its pending row but never binds a session gets VISIBLE.
The producer freezes the launch's window/pane identity onto the Dispatched
event payload (birth records are pi-leg-only, so the pending row is the sole
presence signal for a parked claude wrapper). The daemon's pending-dispatch
sweep — which now sees the window identity on the row — gains a parked grace
at ~90 seconds: above confirmRunning's 60s ceiling, below the 120s TTL so the
distress fires BEFORE the first silent re-serve, preserving the load-bearing
ceiling<TTL<cooldown ordering. On expiry it mints a suppressing sticky
dispatch failure naming the window/pane (cause-agnostic wording — parked or
slow, inspect the window), which suppresses further re-serves (a re-serve
double-launches a parked-but-alive wrapper) and never kills or closes the
window — the dialog stays visible for a human. The sticky level-clears on
positive evidence (a late SessionStart bind — the legit slow-cold-boot case)
and otherwise clears only via retry_dispatch. All detection is producer-side;
the fold only projects the frozen payload. Problem-codes gains the
parked-launch row in the dispatch-guard family.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/autopilot-worker.ts:4318-4470 — confirmRunning ceiling/indoubt path (where the window/pane is known at launch); :4394-4418 transient-vs-permanent feed into never-bound
- src/daemon.ts:12429-12519 — the pending-dispatch sweep the grace joins; db.ts:5843-5896 — never-bound K=3 fold the suppression pre-empts
- src/dispatch-failure-key.ts — key family conventions for the new sticky id

**Optional** (reference as needed):
- src/backstop-telemetry.ts — the sweep telemetry shape
- test/reducer-projections.test.ts — fold projection fixtures

### Risks

- A grace misplaced in the ceiling/TTL/cooldown chain re-opens dispatch mid-confirm (the exact re-serve-and-re-park loop)
- Suppression must not orphan the pending row forever — retry_dispatch remains the human unstick

### Test notes

Deterministic: pending row + no bind past grace mints the sticky with the
window identity and suppresses the TTL re-serve; a bind before grace mints
nothing; a bind AFTER the sticky level-clears it; retry clears and re-arms;
never-bound counting never double-fires alongside the suppressing sticky.

## Acceptance

- [ ] The Dispatched payload carries the launch window/pane identity and the fold projects it
- [ ] A pending dispatch unbound past the grace mints one suppressing sticky naming the window, fires before any silent re-serve, and leaves the window open
- [ ] The sticky level-clears on a late bind, clears via retry otherwise, and never double-counts with the never-bound breaker
- [ ] docs/problem-codes.md carries the parked-launch row
- [ ] Named test gates for the touched suites pass

## Done summary
Added parked-launch distress detection: the producer freezes launch window/pane identity onto the Dispatched event, the daemon sweep mints a self-clearing sticky at a 90s grace (between the 60s confirm ceiling and 120s TTL) naming the window, level-clears on a late bind, and never double-counts with the never-bound breaker. docs/problem-codes.md documents the new parked-launch code.
## Evidence
