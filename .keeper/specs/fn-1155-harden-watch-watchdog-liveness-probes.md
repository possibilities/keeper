## Overview

The event-driven watch supervisor landed with two probe-robustness gaps and
zero coverage in `scripts/watch-watchdog.ts`, the one net-new runtime surface
of the epic. Both gaps make the watchdog emit FALSE anomaly pages — the exact
outcome it exists to prevent — and its two-miss debounce / single-fire /
recovery latch (the core correctness logic) is entirely untested against a
repo whose every sibling landed dense pure-unit tests. This follow-up hardens
the two probe paths and adds the pure-unit coverage that proves them, landing
as one commit against the single file.

## Acceptance

- [ ] The monitors probe no longer deadlocks on child output larger than the
      OS pipe buffer, and no longer counts an unverifiable (own-job-absent /
      null-monitors) sibling as dead.
- [ ] `runWatchdogLoop` has pure-unit coverage of the miss -> miss -> recover
      -> miss episode asserting exactly one anomaly per episode.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | watch-watchdog.ts:210 awaits proc.exited before draining stdout (219) — pipe-backpressure deadlock false-pages busy boards. |
| F2 | kept | .1 | watch-watchdog.ts:266 treats every non-waiting verdict as dead, but met covers unverifiable rows — false-pages every armed watch in the arm window. |
| F3 | kept | .1 | no test/*watchdog* exists; runWatchdogLoop debounce/latch/recovery is unverified — ship the probe fixes with the tests that prove them. |
| F4 | culled | — | bare fn-N: comment prefixes are pervasive pre-existing house style; new code conforms, zero user/behavior impact, a partial strip only fragments the tree. |

## Out of scope

- Stripping the `// fn-N:` provenance-comment prefixes (F4) — pervasive pre-existing
  house style; a tree-wide sweep, not this epic's concern, and deferred.
- The core projector / gated fold / status / watch-delta / await-condition
  surfaces — audited clean, byte-identical off-path, densely covered.
