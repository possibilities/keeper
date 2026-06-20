## Overview

fn-856 ungated the plan-link classifier and bumped SCHEMA_VERSION 76->77 with a
cursor-rewind + projection-wipe migration. That migration deliberately does NOT
wipe `commit_trailer_facts` — it relies on the table's append-only `INSERT OR IGNORE`
(keyed on `event_id`) to keep pre-existing rows idempotent as the rewind re-folds the
same Commit events as no-ops. This is a sacred re-fold-determinism invariant with no
direct test guarding it: a future migration author copying the v77 wipe block could
add `commit_trailer_facts` to the list and silently break classifier edge derivation,
surfacing only as job_links drift. This follow-up adds the missing migration-level
coverage so that "don't wipe the facts table" is enforced, not convention.

## Acceptance

- [ ] A migration-level test seeds `commit_trailer_facts` rows in a pre-v77 DB, migrates 76->77, and asserts those exact rows survive the rewind intact.
- [ ] The same test asserts the classifier (re-fold over the preserved facts) reproduces identical creator/refiner edges, so a regression that wiped or double-counted the facts table would fail it.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | culled | — | src/db.ts:3731-3743 v77 wipe list is byte-identical to v76 — a DRY preference with no current defect; auditor says ship as-is and the canonical-set convention is documented in-comment. |
| F2 | kept | .1 | No test asserts commit_trailer_facts survives the 76->77 rewind-WITHOUT-wipe; refold-equivalence.test.ts:775 wipes-and-rebuilds it (different scenario), leaving the INSERT-OR-IGNORE idempotency the v77 'MUST NOT touch' invariant rests on unguarded. |
| F3 | culled | — | The repopulation behavior is already covered by reducer-links.test.ts:1965 (v77 closer-with-no-opener mints creator edge + created_by_closer_of); the residual gap is generic daemon-refold-on-boot glue this change did not introduce. |

## Out of scope

- A shared `WIPE_ALL_PROJECTIONS` helper to de-duplicate the migration wipe lists (F1) — a refactor with no current defect, deferred.
- Integration-level assertion that the daemon re-folds on boot to repopulate dropped populations (F3) — generic boot machinery already exercised by existing migration tests.
