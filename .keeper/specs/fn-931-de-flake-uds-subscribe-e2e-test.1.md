## Description

**Size:** S
**Files:** test/integration.test.ts, test/helpers/retry-until.ts, src/protocol.ts

### Approach

The test already polls with `retryUntil` (no fixed sleeps), so the most
likely flake is a `retryUntil` deadline that is occasionally too tight for
the fold→serve→subscribe→patch propagation under CI load — OR a genuine
ordering race in the server's patch-after-fold delivery path. First
reproduce by running the single test in a tight loop (see Quick commands)
to confirm it is THIS assertion that flaps and capture which await times
out. If it is a deadline, widen the relevant `retryUntil` timeout/interval
for the patch step (keep polling, never a fixed sleep). If the patch can be
delivered out of order or dropped relative to the post-fold data_version
wake, fix the ordering in the server delivery path rather than masking it
in the test. Do not add a blanket retry/skip on the test.

### Investigation targets

**Required** (read before coding):
- test/integration.test.ts:191 — the flaky test; the query→result then
  patch-after-fold assertions
- test/helpers/retry-until.ts — the poll helper + its default timeout/interval
- src/protocol.ts — the UDS subscribe server: query/result/patch framing and
  the fold→patch delivery path

**Optional** (reference as needed):
- test/bus-worker.integration.test.ts — established retryUntil usage patterns

## Acceptance

- [ ] The flapping assertion is identified and the root cause (deadline vs. delivery race) named in the Done summary
- [ ] Fix applied at the right layer (test deadline OR server ordering), polling-based, no fixed sleeps and no test skip/blanket-retry
- [ ] The single test passes across >=25 consecutive runs locally
- [ ] `bun run test:full` passes

## Done summary

## Evidence
