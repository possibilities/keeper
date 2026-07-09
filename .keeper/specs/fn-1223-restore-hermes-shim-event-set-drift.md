## Overview

The keeperd restart-churn refactor split the hermes shim's registered event
list into the dep-free `src/hermes-shim-contract.ts` while its translation
table `HERMES_EVENT_MAP` stayed hook-side in `hermes-events-shim.ts`. The
two were previously the same object (`HERMES_SHIM_EVENTS = Object.keys(HERMES_EVENT_MAP)`),
making drift structurally impossible; they are now reconciled only by matching
"DRIFT GUARD" comments. This follow-up restores enforcement with a fast-tier
equality test so a future edit to one list without the other fails loudly
instead of silently shipping a stale registered event set.

## Acceptance

- [ ] A fast-tier test fails when `HERMES_EVENT_MAP`'s key set and `HERMES_SHIM_EVENTS` diverge
- [ ] The test passes against the current (matching 9-event) state
- [ ] `bun test` stays green

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept   | .1 | Contract literal list and hook HERMES_EVENT_MAP reconciled only by DRIFT GUARD comments; no test enforces key-set equality, so a declared invariant lost its structural enforcement. |
| F2 | culled | —  | Consider-level DRY of a correct, comment-pointed, byte-identical guarded copy in src/birth-record.ts; no user impact or behavior gap, out of epic scope. |

## Out of scope

- Deduplicating the `src/birth-record.ts` start_time parse against `src/proc-starttime.ts` (audit culled F2 as optional cleanup)
