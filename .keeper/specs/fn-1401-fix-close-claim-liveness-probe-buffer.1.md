## Description

Fixes finding F1 (with F3's test concern merged in). In
`plugins/plan/src/session_markers.ts`, `readProcessStartTime` runs the
darwin probe `spawnSync("ps", ["-ww","-p",<pid>,"-o","lstart=,args="], { ...,
maxBuffer: 4096 })`. `args=` streams the target's full command line, so a
long-argv holder (keeper-spawned workers reach ~26KB argv on-host) overflows
the 4096-byte buffer, `spawnSync` sets `error`, the function returns null,
and `probeHolderLiveness` reports "unknown" — which `readRivalCloseClaims`
defers to the 24h stale bound instead of detecting a dead/recycled holder.

The sibling probe in `src/seed-sweep.ts` runs the identical
`ps -ww -p <pid> -o lstart=,args=` with NO `maxBuffer` cap; `bus-worker.ts`
uses a bounded reader. `splitArgsLstart` consumes only the fixed-width
24-char `lstart` and discards `args`, so raising or removing the cap is safe.

Files:
- `plugins/plan/src/session_markers.ts` (`readProcessStartTime` darwin branch)
- the session-markers test file covering the probe seam (regression guard below)

## Acceptance

- [ ] `readProcessStartTime` no longer returns null for a live process solely
      because its argv exceeds 4096 bytes; buffering matches `seed-sweep.ts`.
- [ ] A regression test drives the probe (or its seam) with a long-argv holder
      and asserts liveness resolves to alive/dead rather than deferring to the
      24h stale bound.
- [ ] Existing close-claim arbitration and kill-path tests stay green.

## Done summary
Uncapped the darwin close-claim probe's maxBuffer so a long-argv holder resolves alive/dead instead of falling through to the 24h stale bound; added a regression test with a 48KB-argv holder.
## Evidence
