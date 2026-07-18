## Overview

The bus-worker retention loop's identity probe (`startTimeViaPs`) spawns a
`ps` subprocess and awaits `proc.exited` with no timeout, kill, or
AbortSignal. The single-flight retention guard added by the source epic
early-returns every future tick while a pass is in flight, so a permanently
hung probe pins `retentionPass` non-null forever and silently wedges ALL
retention work — channel presence sweep, message aging, and WAL bound — for
the worker's life, with no in-process self-heal. This finishes the source
epic's own bounding goal by bounding the one unbounded subprocess left
inside the loop it set out to bound.

## Acceptance

- [ ] A hung/never-exiting `ps` probe cannot pin the single-flight latch or
      starve future retention passes.
- [ ] The probe subprocess is bounded (timeout + kill or AbortSignal) and
      treats a timed-out probe as an inconclusive result (keeps the row),
      matching the existing null-on-failure contract.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | startTimeViaPs (bus-worker.ts:1015) awaits proc.exited on a spawned ps with no timeout; single-flight guard (bus-worker.ts:~1890) leaves retentionPass non-null forever on a hung probe, wedging all retention with no self-heal. |
| F2 | culled | — | Probe-deferred-then-reaped-after-wrap is a straightforward composition of already-tested cursor-advance/wrap and probe-budget-defer primitives; no user impact — below the keep bar. |

## Out of scope

- The keyset traversal, CAS-fenced delete, horizon-inclusive prune, and
  registration-connection retirement shipped by the source epic — audited
  clean, no rework.
- The F2 probe-deferred-reap test path — culled as below the keep bar.
