## Overview

The durable-await evaluator coverage suite drives a hand-written `durableAwaitCases`
table as its source of truth for "every server-side condition kind", but nothing
ties that table to the canonical `DURABLE_AWAIT_CONDITION_KINDS` enum. A future
condition kind can be added to the enum and ship untested while the suite stays
green — silently eroding the completeness guarantee the coverage work exists to
provide. This follow-up makes that guarantee load-bearing with a single enforced tie.

## Acceptance

- [ ] The evaluator coverage suite fails if a condition kind is added to `DURABLE_AWAIT_CONDITION_KINDS` without a corresponding `durableAwaitCases` entry.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | culled | — | spill-guard test already locks the security contract (all inputs rejected, zero AwaitRequested minted); pinning the specific error substring guards only a benign wrong-guard-rejection case against a hypothetical refactor — theoretical, no current defect. |
| F2 | kept | .1 | durableAwaitCases table neither imports nor length-ties DURABLE_AWAIT_CONDITION_KINDS, so a 15th kind ships untested with a green suite. |
| F3 | culled | — | only two WorkerSpy/sandbox instances exist and they diverge (extraction non-trivial); repo standard and the auditor's gate tolerate duplication until a third appears — DRY preference, not a defect. |

## Out of scope

- Pinning per-guard error substrings in the daemon spill-guard test (F1, culled — security contract already covered).
- Extracting a shared daemon-boot-under-WorkerSpy helper (F3, culled — two divergent instances, below the repo's third-instance threshold).
