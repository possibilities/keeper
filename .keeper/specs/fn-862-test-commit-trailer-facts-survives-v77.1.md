## Description

Addresses audit finding F2 (Test Gap). The fn-856 v76->v77 migration
(src/db.ts:3729-3744) rewinds the cursor and wipes the canonical projection
list but DELIBERATELY omits `commit_trailer_facts` (the comment at
src/db.ts:3718-3719 calls out "MUST NOT touch"). Idempotency across the
rewind rests on that table's append-only `INSERT OR IGNORE` keyed on
`event_id`: the re-fold replays the same Commit events as no-ops and the
rows stay consistent. No existing test guards this specific interaction —
db.test.ts has zero `commit_trailer_facts` survival case across the rewind,
and refold-equivalence.test.ts:775 (`rewindAndWipeProjections`) explicitly
`DELETE`s the table before re-folding, which is the wipe-and-rebuild
scenario, NOT the rewind-without-wipe-preserves-rows scenario this change
introduced. reducer-links.test.ts:1965 covers the live-fold edge derivation
but not the migration-preserves-facts seam.

Add a migration-level test (db.test.ts, alongside the other v77 cases): seed
a pre-v77 DB with known `commit_trailer_facts` rows, run migrate() to head,
assert (a) those exact rows survive byte-for-byte, and (b) the classifier
re-fold over the preserved facts reproduces the same creator/refiner edges.

## Acceptance

- [ ] Test seeds `commit_trailer_facts` rows in a pre-v77 DB, migrates 76->head, and asserts the seeded rows survive the rewind intact (id + values).
- [ ] Test asserts the post-migrate classifier produces identical creator/refiner edges, so a regression that added the table to the wipe list or double-counted it fails.
- [ ] `bun run test:full` passes (touches db/migration path).

## Done summary
Added a migration-level test in db.test.ts: seeds commit_trailer_facts rows + backing Commit events in a pre-v77 DB, migrates 76->head, and asserts the facts survive the v77 projection wipe intact and the re-fold reproduces byte-identical creator/refiner edges. Verified it fails when the table is added to the wipe list.
## Evidence
