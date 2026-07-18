## Description

Addresses F1 (kept) with F3 (merged-into-F1) folded in. In
src/restart-observation.ts the `frozenLedgerValid` conjunct was added to
the SHARED `proven` gate (audited commit 1a9d887b4, gate at line 549),
so it governs the exact-replacement path as well as the crossing path.
The parent gate (`git show 1a9d887b4^:src/restart-observation.ts`, line
497) validated only `ledger_marker !== null`, never the whole frozen
ledger — so an exact restart whose frozen ledger holds any invalid
non-marker boot now trips `pre-restart-ledger-invalid` and returns
`unproven`, contradicting the commit's "exact branch unchanged
byte-for-byte" claim.

Scope the conjunct so it only gates the crossing path (e.g. require
`frozenLedgerValid` only when `crossingPath`, leaving the exact path's
gate as it was in the parent). F3 is the regression test that proves this:
an exact-replacement fixture with a valid marker but an invalid non-marker
frozen boot must still prove.

Files: src/restart-observation.ts, test/restart-observation.test.ts

## Acceptance

- [ ] The exact-replacement path proves when the frozen ledger marker is valid even if an earlier non-marker frozen boot is invalid.
- [ ] The crossing path still requires every frozen boot valid (an invalid frozen boot yields `pre-restart-ledger-invalid` / unproven).
- [ ] A deterministic test asserts the exact-path-with-invalid-non-marker-boot case proves.

## Done summary
Scoped the frozenLedgerValid conjunct in the proven gate to the identity-capability crossing path only, restoring the exact-replacement path's parent behavior (an invalid non-marker frozen boot no longer blocks an exact restart from proving). Added a regression test covering an exact restart with a valid marker but an invalid earlier frozen boot.
## Evidence
