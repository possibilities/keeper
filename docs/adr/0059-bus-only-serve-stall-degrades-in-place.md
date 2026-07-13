# 59. A bus-only serve stall degrades in place, never fatalExits

## Status

Accepted.

## Context

The serve-liveness watchdog ([ADR 0003](0003-fatal-exit-over-self-heal.md)) treats
every named trigger — accept-stall on either socket, busy-lag, serve-report-mute,
serve-starvation — as grounds for `fatalExit`, on the theory that a clean restart
from durable state beats in-process patching. That theory holds only when a
restart can actually clear the fault. The Agent Bus accept probe fails under
*external* pressure (a client-side subscriber storm hammering the accept loop),
and a restart does nothing to the external cause: the daemon boots, the storm
resumes, the probe fails again, and launchd respawns it on a cycle short enough
to sail past its throttle heuristic. A two-hour production crash-loop ran exactly
this circuit while the READ server probe stayed green the entire time — the
critical control path was healthy, and restarting it repeatedly was pure
amplification. The tmux control worker already established the corrective
precedent: a non-critical subsystem that cannot sustain its connection degrades
in place instead of forcing a process restart.

## Decision

The serve-liveness verdict gains a third kind: `degrade`. An `accept-stall-bus`
trip — reachable only when the READ server probe is green, because the reducer
checks the server streak first — resolves to `degrade`, never `escalate`. The
consumer on main answers a degrade by minting one idempotent, level-triggered
distress row (a paging surface, so a human learns the bus is down even though the
daemon keeps serving) and leaving the bus probe armed; the row level-clears the
moment the probe recovers. Every other trigger — including `accept-stall-server`
— keeps its `fatalExit` semantics unchanged. The no-in-process-self-heal rule is
not weakened: the bus worker is never respawned in place, so an *internal* bus
wedge now stays visibly degraded behind its paging distress until an operator
restarts the daemon. That trade is accepted deliberately — a restart-recoverable
internal wedge is rarer and cheaper than the externally-driven crash-loop this
decision removes.

## Consequences

- A bus-side storm can no longer take down the control plane; the board keeps
  folding, serving, and dispatching while the bus is degraded and paged.
- Fatal restart authority is scoped to the critical read path, matching the
  watchdog-design principle that the supervisor heartbeat means "the critical
  control path is making progress," not "everything is perfect."
- An internal bus deadlock that a restart would have cleared now requires an
  operator bounce, surfaced by the distress row rather than masked by a silent
  respawn cycle.
- The degrade verdict is a pure reducer branch with its own truth-table rows, so
  the fatal/degrade boundary is regression-locked.
