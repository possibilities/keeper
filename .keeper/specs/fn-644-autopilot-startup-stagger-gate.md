## Overview

Add an occupancy-based startup-stagger gate to autopilot so at most one
freshly-dispatched claude session is "settling" (launched but not yet
observed reaching a `running`-tag verdict) at a time. A dispatch holds the
single settling slot from launch until its row is observed running, then
frees it — so long-running parallel workers all still run; only the
simultaneous cold-start burst is capped. As a side effect this closes the
duplicate-dispatch race where `work::fn-642…1` launched 1ms after
`fn-641` fulfilled on a transiently-`stopped` job, slipping past both the
per-root mutex and the `isLiveSessionInRoot` gate at the fulfillment
boundary.

## Quick commands

```
bun test test/autopilot.test.ts
```

## Acceptance

- [ ] At most one settling (launched-but-not-yet-running) dispatch in
  flight; further ready rows are deferred and drained one at a time as
  slots free, with full steady-state parallelism preserved.
