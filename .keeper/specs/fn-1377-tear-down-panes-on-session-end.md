## Overview

An AUTOPILOT-DISPATCHED session that reaches a terminal state (ended,
killed, autoclosed) leaves its tmux pane and wrapper shell alive forever:
pane teardown is mint-driven only, so a completed worker's pane has no
future contender and lingers as litter (mike-witnessed). The lingering
pane is also a #58 aggravator. After this epic, autopilot workers'
terminal transitions own their pane teardown and a bounded GC catches
stragglers.

## Scope boundary (load-bearing — a mis-scoped manual sweep already happened once)

Teardown candidates are EXCLUSIVELY autopilot-dispatched board sessions —
dispatch_origin autopilot / plan-verb work, close, resolve, deconflict,
repair, unblock. Named sessions, handoffs, free-form operator dispatches,
manual and adopted sessions are NEVER candidates in ANY state: the human
keeps those tabs deliberately, including long after their agent exits.
A stopped-or-ended job state on a non-autopilot session is normal resting
state, not litter.

## Quick commands

- bun test ./test/autopilot-worker.test.ts ./test/reclaim.test.ts
- bun run typecheck
- post-deploy census: agent-dead shells of terminal AUTOPILOT jobs trend to zero; named/handoff tabs untouched

## Acceptance

- [ ] An autopilot-dispatched session reaching a terminal state with a daemon-owned pane has that pane (shell included) torn down within one bounded window.
- [ ] A non-autopilot session's pane (named, handoff, free-form, manual, adopted) is never a teardown candidate in any state, proven by tests.
- [ ] A live agent's pane is never a candidate, under the occupancy pass's conservative guards.
- [ ] Terminal-state autopilot panes that missed transition teardown are collected by a bounded, capped periodic GC.

## Early proof point

Task that proves the approach: ordinal 1. If transition-owned teardown
proves racy against late lifecycle evidence, ship the bounded GC alone
and record the deviation.

## References

- Backlog #64 (census + mechanism + the mis-scoped manual sweep that motivated the hard boundary); ADR 0095
- depends_on fn-1375-reap-stopped-sessions-release-claims (shared reaper surface; lands first)
- Distinct from #1's stale-working cascade (working rows with dead agents are ownership-cascade domain)
