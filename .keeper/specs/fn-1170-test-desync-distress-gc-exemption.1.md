## Description

Finding F1 (evidence: `src/daemon.ts:409` `if (isSharedDesyncDistressKey(row.verb, row.id)) continue;`
is exercised by no test; the existing exemption test at `test/daemon.test.ts:284` seeds only
wedge/dirty/lane-wedge/crash-loop rows and asserts `swept===2`). Add a `shared-checkout-desync`
row to the `gcUnretryableDispatchFailures` exemption coverage — mirror the tested stale/lane-wedge
sibling pattern: seed a row under `SHARED_DESYNC_DISTRESS_VERB` / `SHARED_DESYNC_DISTRESS_ID_PREFIX`,
run the sweep, and assert the desync row is NOT in the cleared set (it stays exempt), alongside the
existing wedge/dirty drain assertions.

Files:
- `test/daemon.test.ts` — extend the `gcUnretryableDispatchFailures ... EXEMPTS` test (or add a sibling test) to cover the desync exemption.

## Acceptance

- [ ] A test seeds a `shared-checkout-desync` distress row and asserts it survives `gcUnretryableDispatchFailures` (not cleared).
- [ ] `bun test test/daemon.test.ts` passes.

## Done summary

## Evidence
