## Description

Completes finding F2 from the fn-1386-harden-trunk-lease-integration close
audit. Task .1 relocated three error-emission branches out of
`requestTrunkLease` into `integrateRepoUnderLease`
(`plugins/plan/src/verbs/close_finalize.ts`, ~:200-215 and ~:860-877) but
the saga suite `plugins/plan/test/saga-close-finalize.test.ts` leaves them
uncovered: `makeFakeTrunkDeps` (line ~1896) always returns
`requestLease: {ok:true}` (line 1927) and no case sets its `lockOk` option
(declared line 1888) to `false`. Add three saga cases over the existing
harness:

- `requestLease: () => ({ok:false, reason:"request_failed"})` asserting the
  `TRUNK_LEASE_REQUEST_FAILED` error code.
- `requestLease: () => ({ok:false, reason:"pending"})` asserting the
  `TRUNK_LEASE_PENDING` error code.
- `lockOk:false` asserting the lock-contention exit code.

Files: `plugins/plan/test/saga-close-finalize.test.ts` (extend the harness's
`FakeTrunkDepsOptions` to script `requestLease` if needed; no production
code change).

## Acceptance

- [ ] A saga case injects `requestLease → {ok:false, reason:"request_failed"}` and asserts the `TRUNK_LEASE_REQUEST_FAILED` emit.
- [ ] A saga case injects `requestLease → {ok:false, reason:"pending"}` and asserts the `TRUNK_LEASE_PENDING` emit.
- [ ] A saga case sets `lockOk:false` and asserts the lock-contention exit code.
- [ ] No production source under `plugins/plan/src/` is modified; the named test gate passes.

## Done summary

## Evidence
