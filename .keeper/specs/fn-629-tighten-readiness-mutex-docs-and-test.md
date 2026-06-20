## Overview

The two-pass mutex refactor (fn-627) narrowed pass-1 claimants from "any
non-completed verdict" to the four `isLiveWorkOccupant` live-work kinds, but
the JSDoc above both mutex functions still describes the old "any non-completed"
semantics and the surrounding tests carry names and comments that overstate
which verdicts claim the slot. This follow-up corrects the stale docs, fixes
the misleading test names, and adds the missing negative-control tests that
lock in the narrowed whitelist against future regression.

## Acceptance

- [ ] JSDoc above `applySingleTaskPerEpicMutex` and `applySingleTaskPerRootMutex` describes the two-pass semantics (pass-1 = live-work only; pass-2 = ready/close tiebreak) and no longer says "any non-completed verdict"
- [ ] Test names updated from "non-completed non-ready row STILL claims the slot" to "live-work blocked row claims the slot" with comments enumerating the four `isLiveWorkOccupant` kinds
- [ ] One negative-control test per mutex: a `dep-on-task`-blocked row in position 1 does NOT steal the slot from a `ready` row in position 2

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1     | kept   | .1   | Stale JSDoc explicitly says "any non-completed verdict" — directly contradicts `isLiveWorkOccupant` JSDoc immediately below; would mislead a contributor adding a new `BlockedReason` variant |
| F2     | kept   | .1   | Test name implies `dep-on-task` would also claim the slot; a future contributor could swap it in "without changing intent" and be surprised |
| F3     | kept   | .1   | No test covers `dep-on-task`-first, `ready`-second — the exact regression vector the two-pass fix closes; whitelist broadening would silently reintroduce the production bug |

## Out of scope

- Behavioral changes to the mutex logic
- Coverage of BlockedReason variants beyond the dep-on-task negative-control case
