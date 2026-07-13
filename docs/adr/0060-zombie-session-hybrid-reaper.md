# 60. Zombie sessions: reap the proven-finished, page the ambiguous

## Status

Accepted.

## Context

A daemon restart marks every job row `stopped` because attachment can no longer
be proven, but the agent OS processes themselves survive the restart. Most exit
on their own; some linger alive-but-idle. When such a lingering process owns a
task that is already done-stamped — its work committed, its terminal lifecycle
event eaten by the restart — the board wedges: completion requires done AND
idle, the open sub-agent invocation holds the verdict at `running:sub-agent-stale`
by design, and nothing in keeper will end the process. The monitor-slot backstop
([ADR 0013](0013-jobs-lifecycle-stamp-and-stuck-sentinel.md),
[ADR 0024](0024-stuck-sentinel-orphan-reconciliation.md)) is deliberately "a
paging producer, never a reaper," because killing by recorded pid risks a
misfire: pid reuse can name an innocent process, and an agent that merely looks
idle may be mid-inference. That conservatism made the human the reaper — every
restart-orphaned zombie required a hand-kill to unwedge the board.

## Decision

Keeper gains kill authority over exactly one state, and pages for everything
else. The zombie-session reaper acts only when every clause of the
high-confidence conjunction holds: the job row is `stopped`, its plan task is
done-stamped, the recorded pid is alive, and harness activity shows no evidence
of work past a generous grace window. Even a false positive then kills a session
whose assignment is already finished and committed. The kill itself is guarded:
process identity is re-verified by pid plus OS start-time immediately before
each signal (pid reuse aborts the kill), the command line must match a
keeper-launched agent, and the ladder is SIGTERM, a grace wait, then SIGKILL —
SIGTERM first because a cleanly-exiting harness fires its stop hooks and lands
the terminal lifecycle events on its own. Because a SIGKILL'd or hook-less
process lands no such event, readiness gains the matching escape valve: an open
sub-agent invocation is discounted when the owning pid is proven dead and the
worker phase is done. Any state outside the conjunction — a `working` row, a
live pid with ambiguous activity, a defunct kernel zombie that no signal can
reach — stays page-only under the existing backstop doctrine.

## Consequences

- The restart-orphaned wedge self-heals: done work completes without a human
  hand-killing processes, and dependent tasks unblock.
- Kill authority is bounded by an evidence conjunction rather than a timeout
  heuristic, so the blast radius of the worst false positive is a
  finished session dying early — never lost work.
- The monitor-slot backstop's page-only stance survives unchanged for every
  ambiguous state; the reaper and the backstop split cleanly on the
  done-stamped clause.
- The readiness escape valve closes the wedge even when a kill lands no
  lifecycle event, so the reaper's correctness never depends on harness
  cooperation.
