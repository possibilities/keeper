## Overview

A keeper-dispatched session that reaches a terminal state (ended, killed,
autoclosed) leaves its tmux pane and wrapper shell alive forever: pane
teardown is mint-driven only, so a completed session's pane has no future
contender and lingers as litter (mike-witnessed; census found 10 of 24
panes shell-alive/agent-dead). The lingering pane is also a #58
aggravator — it keeps the dead session "occupying" its key. After this
epic, terminal transitions own their pane teardown and a bounded GC
catches the stragglers.

## Quick commands

- bun test ./test/autopilot-worker.test.ts ./test/reclaim.test.ts
- bun run typecheck
- "tmux list-panes -a" census after deploy: agent-dead shells of terminal jobs trend to zero

## Acceptance

- [ ] A session reaching a terminal state with a daemon-owned pane has that pane (shell included) torn down within one bounded window.
- [ ] A live agent's pane is never a teardown candidate, under the same conservative guards the occupancy pass uses.
- [ ] Terminal-state panes that missed their transition teardown (daemon restart window) are collected by a bounded, capped periodic GC.

## Early proof point

Task that proves the approach: ordinal 1. If transition-owned teardown
proves racy against late lifecycle evidence, ship the bounded GC alone
(it converges litter to zero within its sweep cadence) and record the
deviation.

## References

- Backlog #64 (census evidence + mechanism); ADR 0095 (fn-1375's reap semantics this epic composes beside)
- depends_on fn-1375-reap-stopped-sessions-release-claims: shared src/autopilot-worker.ts + src/daemon.ts surface; fn-1375's stopped-session reap must land first so teardown semantics compose, not collide
- Distinct from #1's stale-working cascade: rows marked working with dead agents are ownership-cascade domain; this epic touches only TERMINAL-state jobs' panes
