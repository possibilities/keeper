## Overview

archive-recovered-dead-letters.ts has zero direct test coverage for its data-safety contract: the allConfirmed gate, ids.length === 0 early-exit, recovered-but-no-replayed_event_id exclusion, and --apply move behavior. A targeted test block pins the four branch cases to guard against silent regression in the script's eligibility logic.

## Acceptance

- [ ] File with one still-waiting record is left in place
- [ ] Recovered-but-missing replayed_event_id record excluded; file stays
- [ ] All-torn file (ids.length === 0) left untouched
- [ ] --apply moves eligible file to archive/ subdir

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | culled | — | tier_0 — wasted readFileSync on pathological oversized file; fails safe by construction, no correctness risk |
| F2 | kept | .1 | Zero direct coverage for allConfirmed/ids.length/replayed_event_id/--apply branches; DATA-SAFETY CONTRACT could regress silently |

## Out of scope

- Missing MAX_DEAD_LETTER_FILE_BYTES cap mirror (F1, tier_0 — fails safe, advisory only)
- Testing scanDeadLetterDir/recoverOneDeadLetter contracts (already covered by existing tests)
