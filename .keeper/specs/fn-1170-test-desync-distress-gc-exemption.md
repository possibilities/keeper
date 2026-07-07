## Overview

The shared-checkout-desync distress family is a live-producer needs_human row, and
`gcUnretryableDispatchFailures` in `src/daemon.ts` exempts it from the orphan sweep so a
real desync signal is never reaped out from under its content-probe level-trigger. That
exemption branch is the one arm of the function with no test — its siblings (crash-loop,
lane-wedge, and the wedge/dirty drain) are all covered. This follow-up closes that gap so
a future refactor cannot silently drop the exemption and let a live desync row vanish.

## Acceptance

- [ ] The `gcUnretryableDispatchFailures` exemption test seeds a `shared-checkout-desync` row and asserts it survives the sweep.
- [ ] The fast suite (`bun test test/daemon.test.ts`) passes.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | daemon.ts:409 isSharedDesyncDistressKey exemption is uncovered; the sole exemption test (test/daemon.test.ts:284) seeds no desync row, so a refactor could silently reap a live needs_human desync row with nothing red. |
| F2 | culled | — | probeSharedCheckoutDesync clear condition is a documented by-design tradeoff (ADR 0016 + doc-comment); no false mints, and the proposed relaxation is the index-vs-HEAD orientation the positive-evidence contract rejects. |

## Out of scope

- Relaxing the `probeSharedCheckoutDesync` clear condition (F2) — deliberate positive-evidence design per ADR 0016.
- The `main()` reconcile-loop glue test — the auditor noted it as matching the repo's no-real-daemon philosophy, not a required add.
