## Overview

A worker whose base gate is starved (host overload, timeout) can today stamp
`SHARED_BASE_BROKEN` from inconclusive evidence, minting a false
`repair::<repo>` distress row. The daemon's own baseline path already gets
this right (timeout/infra never counts as red; only confirmed suite-red
mints a candidate) — the worker-stamped attestation path is the one seam
without the guard. Narrow it: an inconclusive (timed-out/starved) gate
defers and retries; only a confirmed red attests. The safety net for
genuinely broken trunks stays fully intact.

## Quick commands

- bun test test/daemon.test.ts — the selectRepairCandidates / classifyBaselineForRepair tiers

## Acceptance

- [ ] A worker whose base gate times out or is starved does not attest SHARED_BASE_BROKEN; it defers/retries with backoff, and a confirmed suite-red still attests exactly as today.
