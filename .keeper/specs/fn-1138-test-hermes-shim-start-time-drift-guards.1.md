## Description

Finding F1 (test-coverage). Evidence: `plugins/keeper/plugin/hooks/hermes-events-shim.ts`
defines `darwinLstartToStartTime` (line 228, module-private), `linuxStatToStartTime`
(line 250, module-private), and `probeParentStartTime` (line 272, exported), each marked
"DRIFT GUARD: byte-identical to birthRecord's ..." The birth-record originals are tested
at `test/birth-record.test.ts:198-210`, but `test/hermes-shim.test.ts` references none of
the shim copies — the self-seed tests inject start_time via a lazy thunk, so the real
parsers never execute under test. A silent drift from the birth-record source would go
uncaught and break the `(pid, start_time)` recycle witness (an adopted row resurrected
onto a stranger's pid).

Add coverage that enforces the byte-identical parity — prefer a shared fixture the
birth-record test also consumes (or a direct equivalence assertion between the two
implementations) over duplicating hand-written expectations, so the "DRIFT GUARD" comment
is backed by an assertion rather than prose. The two darwin/linux parsers are currently
module-private; export them (or route the test through `probeParentStartTime`) as needed
to make the parity assertable.

Files:
- `plugins/keeper/plugin/hooks/hermes-events-shim.ts`
- `test/hermes-shim.test.ts`
- `test/birth-record.test.ts` (shared fixture, if used)

## Acceptance

- [ ] A test exercises the shim's `darwinLstartToStartTime` and `linuxStatToStartTime` on the same inputs as the birth-record originals and fails if the outputs diverge.
- [ ] The parity anchor is shared (single source of truth) rather than two independently-maintained expectation sets.
- [ ] `bun test` stays green.

## Done summary
Exported the shim's darwin/linux start_time parsers and added a shared fixture + direct equivalence test asserting parity with birth-record's originals, backing the DRIFT GUARD comments with a real assertion.
## Evidence
