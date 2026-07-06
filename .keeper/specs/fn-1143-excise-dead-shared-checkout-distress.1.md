## Description

Originating finding F1 (auditor: speculative-generality, src/autopilot-worker.ts:1079,1102).
Evidence path: in the delivered tree 7a0fe194 the exported predicates
`isSharedCheckoutWedgeReason` (line 1079) and `isSharedCheckoutDirtyReason`
(line 1102) have no production caller - a full-tree scan finds references only
in test/autopilot-worker.test.ts (imports + two unit tests). Task .2 (the neuter
commit) explicitly stated this machinery is "torn down in the sequenced follow-up."

Files:
- src/autopilot-worker.ts - remove the exported predicates
  `isSharedCheckoutWedgeReason` / `isSharedCheckoutDirtyReason` and their now-unused
  prefix constants `SHARED_CHECKOUT_WEDGE_REASON_PREFIXES` /
  `SHARED_CHECKOUT_DIRTY_REASON_PREFIX`. FIRST verify each symbol is truly
  unreferenced in production; for the recover-pass mid-merge self-heal, remove ONLY
  what is genuinely dead and PRESERVE any still-live `git merge --abort` abort
  behavior of keeper-owned residue (only the distress-minting was neutered).
- test/autopilot-worker.test.ts - drop the imports and the two unit tests that
  exercise the removed predicates.

## Acceptance

- [ ] `isSharedCheckoutWedgeReason`, `isSharedCheckoutDirtyReason`, and their unused prefix constants are gone from src/autopilot-worker.ts
- [ ] No production or test reference to the removed symbols remains (grep-clean)
- [ ] Live recover-pass abort behavior is untouched; only distress-dead machinery is removed
- [ ] `bun test` passes

## Done summary
Removed the dead isSharedCheckoutWedgeReason/isSharedCheckoutDirtyReason predicates and their unused prefix constants (re-verified live against default after the fn-1140 merge landed); dropped their two unit tests. Live recover-pass git merge --abort self-heal untouched.
## Evidence
