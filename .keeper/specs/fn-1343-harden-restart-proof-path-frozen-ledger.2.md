## Description

Addresses F4 (kept). The crossing feature's defining positive scenario —
an identity-incapable predecessor crossing to a successor that is
genuinely absent from a NON-EMPTY, fully valid frozen ledger snapshot —
is untested. Existing crossing tests cover only the empty-snapshot proven
case and the present-in-set rejection (`successor-present-before-restart`).
ADR 0086 (docs/adr/0086-positive-legacy-service-restart-crossing.md) calls
for deterministic fixtures over the compatibility matrix; this cell is
missing.

Add a deterministic fixture where `pre_restart.service` is
`identity-incapable`, the frozen ledger is readable with a non-empty set
of valid boots, and the caught-up healthy successor's identity is absent
from that set — assert `verdict: proven` and
`proof_path: identity-capability-crossing`.

Files: test/restart-observation.test.ts

## Acceptance

- [ ] A test proves the crossing path against a non-empty valid frozen set with a genuinely absent successor.
- [ ] The assertion checks both `verdict: proven` and `proof_path: identity-capability-crossing`.

## Done summary

## Evidence
