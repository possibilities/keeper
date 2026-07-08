## Description

Reconciles finding F1 from the fn-1198 close audit. In `src/daemon.ts`,
`RepairCandidateDropClass` is `not_blocked | reason_unreadable |
non_repair_category | empty_repo` (JSDoc-billed as the class-stable
grep/alarm contract), and `selectRepairCandidates` routes its four drop
gates through a typed `drop()` helper constrained to that union. But the
grouping loop in `runRepairEscalationSweep` emits a RAW
`note(\`# repair-candidate-drop task=... class=empty_token ...\`)` line
that bypasses the typed helper and is NOT a union member — so an operator
alarm keyed off the documented union silently misses `empty_token` drops.

Evidence path (audited commit e676639): the union definition, the typed
`drop()` helper, and the off-union `class=empty_token` emission all live in
`src/daemon.ts`; the union-length test lives in `test/daemon.test.ts`
(`RepairCandidateDropClass: the class union is stable`, pins length 4).

Pick ONE reconciliation and apply it end to end:
- add `empty_token` to `RepairCandidateDropClass` and route the sweep's
  emission through the typed `drop()` helper (it is a defensive,
  effectively-unreachable guard like `empty_repo`, so the cost is one
  union member), OR
- move the `empty_token` emission to a distinct prefix outside the
  `repair-candidate-drop` grep contract.

Files: `src/daemon.ts`, `test/daemon.test.ts`.

## Acceptance

- [ ] No `# repair-candidate-drop` line can be emitted with a `class` value
      outside the documented drop-class contract.
- [ ] The union-stability test in `test/daemon.test.ts` is updated to match
      the reconciled membership and stays green.
- [ ] `bun test` passes.

## Done summary

## Evidence
