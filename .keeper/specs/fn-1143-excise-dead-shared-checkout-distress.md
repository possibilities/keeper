## Overview

The base->default merge decouple neutered the shared-checkout distress path but
left its detection machinery behind: two exported predicates and their prefix
constants now have no production caller, and the recover-pass mid-merge self-heal
is inert w.r.t. distress minting. This follow-up excises the confirmed-dead
predicates so they don't ossify as permanently-dead exports, while preserving any
still-live abort behavior in the recover pass.

## Acceptance

- [ ] The two dead exported predicates and their now-unused prefix constants are removed
- [ ] Only genuinely-unreferenced self-heal machinery is removed; live merge --abort behavior is preserved
- [ ] The test suite no longer references the removed predicates and `bun test` stays green

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept   | .1 | Dead exported predicates confirmed at 7a0fe194:src/autopilot-worker.ts:1079,1102 with no production caller; task .2 explicitly staged them for follow-up teardown |
| F2 | culled | —  | Cited "(the incident this decouples)" comment was added by task .1 but reworked out by task .2 - absent from the delivered tree, no defect exists |

## Out of scope

- The base->default merge plumbing pipeline itself (shipped and audited clean)
- The `sharedCheckoutDistressObservations()` neuter seam and boot orphan-GC drain (deliberate, live)
- Any change to the recover pass's live `git merge --abort` self-heal of keeper-owned mid-merge residue
