## Overview

Ends the two operator treadmills that dominate board babysitting: stopped
sessions of any verb strand their occupancy until a human TERM+retry
(observed 5+/day across work:: and close::), and operator kills leave
acquired claims bound to dead sessions that silently starve the freed task
~25 minutes. Decisions are recorded in ADR 0095; after this epic the
reconciler reaps stopped squatters on grace, releases dead-session claims,
and explains every withhold of ready work.

## Quick commands

- bun test ./test/autopilot-worker.test.ts ./test/reclaim.test.ts ./test/dispatch-failure-pill.test.ts
- bun run typecheck
- grep "withhold target=" on keeperd stderr — every withheld ready target carries a code

## Acceptance

- [ ] A stopped session (any tracked verb) past grace is reaped without operator action, and a fatal_halt close receipt frees its occupancy immediately.
- [ ] An operator-killed session's claim releases without a manual autopilot retry once its Provider legs are settled or absent.
- [ ] No reconciler decline of a ready target is silent, including degraded-probe cycles.

## Early proof point

Task that proves the approach: ordinal 1. If the pure-seam reap decision
proves unsafe against the conservative guards, fall back to paging with a
precise reason naming the squatter pid/pane instead of reaping —
visibility still lands.

## References

- docs/adr/0095 (this epic's decisions; amends 0085); ADRs 0085/0071/0060/0083
- Dep direction: fn-1350/fn-1351/fn-1352 are wired to depend on THIS epic
  (reverse of the scout's default) because they are unvalidated ghosts
  behind an offline peer's review gate — the urgent operational fix runs
  first; the ghosts rebase at validation time. Overlaps: fn-1352.1
  occupancy-probe retirement + fn-1352.2 readiness/pill surfaces;
  fn-1350.4 concurrency budget + fn-1350.3 close terminal; fn-1351
  daemon.ts dispatch region.
- Backlog #58 (21p) + #33 (7f) evidence in ~/docs/keeper-phase2-backlog.md
- Reverified: the never-bound crash-window class of #33 is already covered
  on main by ADR 0085's reaper; this epic's release class is its
  dead-session sibling.

## Docs gaps

- **docs/problem-codes.md**: withhold table gains the new codes (owned by task 2)

## Best practices

- **Lease-expiry as authority, liveness as accelerator:** reap on positive stopped-evidence plus grace, never on pid-liveness alone [queue/reaper canon]
- **Terminal verdict releases immediately:** grace is for ambiguity; fatal_halt is not ambiguous [scheduler canon]
- **TERM then grace then KILL:** a SIGSTOP'd pid takes TERM only on resume; KILL collects it
- **Always-emit-a-reason scheduling:** absence of a failure event must not be indistinguishable from health [kube-scheduler]
