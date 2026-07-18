## Overview

The restart identity-capability-crossing work added a `frozenLedgerValid`
conjunct to the SHARED `proven` gate, unintentionally tightening the
exact-replacement path so an exact restart whose frozen ledger holds any
invalid non-marker boot now returns `unproven` — contradicting the commit's
"exact branch unchanged byte-for-byte" claim. This follow-up scopes that
conjunct to the crossing path, adds its regression test, and closes the
crossing feature's untested defining positive case (proving a genuinely
absent successor against a non-empty valid frozen set).

## Acceptance

- [ ] The exact-replacement `proven` gate no longer rejects on an invalid non-marker frozen boot; the crossing path still requires a fully valid frozen snapshot.
- [ ] The crossing feature's positive non-empty-valid-set case is covered by a deterministic test.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | restart-observation.ts:549 frozenLedgerValid conjunct in the shared proven gate governs exactPath too; parent 1a9d887b4^ gate had no whole-ledger check, so an exact restart with an invalid non-marker frozen boot now returns unproven, contradicting the byte-for-byte-unchanged claim |
| F2 | culled | — | restart-observation.ts:340-342 boot_id-only reuse seam is theoretical (needs a boot_id collision with differing pid/start_time) and auditor-acknowledged as defensible-not-a-gap |
| F3 | merged-into-F1 | .1 | F3 (uncovered exact-path-with-invalid-frozen-boot behavior) is the regression test for F1's fix and lands in the same commit; same root cause |
| F4 | kept | .2 | crossing-proven against a non-empty valid frozen set with a genuinely absent successor is the feature's defining positive scenario and is untested |

## Out of scope

- The boot_id-only reuse hardening on the crossing newness check (F2) — theoretical seam, no user-observable impact.
- Any change to the crossing proof semantics or the `proof_path` output contract.
