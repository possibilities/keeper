## Description

**Size:** M
**Files:** src/compaction.ts, src/db.ts, keeper/api.py, test/refold-equivalence.test.ts, test/compaction.test.ts, README.md, CLAUDE.md

### Approach

keeper.db is 1.16GB / 4.4M events and grows unbounded: retention (`retainColdPayloads`,
src/compaction.ts:286) only NULLs shed-class BODIES — it reclaims body bytes but never
deletes rows, so per-row overhead accumulates (~GB residual). Bound ROW growth by
physically DELETING old shed-class rows. This is the epic's highest-risk prong because
today's re-fold proof holds PRECISELY because rows survive (NULLed); deleting rows
removes `events.id` entries a re-fold iterates. So the FIRST deliverable is the
determinism PROOF, and the physical delete ships only if it passes.

Two-stage, rollback-safe: (stage 1) add an `is_shed_deleted` column (SCHEMA_VERSION
84→85; bump `keeper/api.py` SUPPORTED_SCHEMA_VERSIONS in the SAME commit; cheap
column-add defaulting 0, no backfill write) and MARK cold shed-class rows
(reuse `RETENTION_SHED_CLASS_PREDICATE`, gated `id <= coldWatermark AND id < cursor` —
the same gate as the NULL pass, and NEVER inside T4's computeMonitors bound, reconcile
the watermarks); (stage 2) physically `DELETE` marked rows in BOUNDED batches
(500–5000/txn, the existing `.immediate()` shape) + `wal_checkpoint` after batches +
`incremental_vacuum`, all in keeper's OWN writer process (a separate process + long
reader pins the WAL). Re-spec `countAbsentBlobs` (:520) so an ABSENT shed-class row is
not a false data-loss alarm while an absent KEEP-SET row still is. Update the README
compaction section + the CLAUDE.md retention invariant (the charter becomes "re-fold
determinism holds over the surviving rows" — state it).

### Detailed phases

1. Audit every `events` reader in folds/producers for `COUNT(*)`, `MAX(id)`, id-contiguity,
   or all-id iteration. `computeColdWatermark`'s `MAX(id)` (:249) is the one known MAX(id)
   and is safe (deleting cold tail only lowers it). Confirm NO fold's output changes when
   a shed-class row below the cursor vanishes.
2. EXTEND test/refold-equivalence.test.ts: seed a corpus spanning EVERY shed-class type,
   run the DELETE pass, then run two from-scratch re-folds over the POST-DELETE row set
   and assert byte-identical PLUS no deleted id changes any count. This is the gate.
3. Only if (1)+(2) pass: implement stage 1 (column + mark) then stage 2 (batched delete + vacuum).

### Investigation targets

**Required** (read before coding):
- src/compaction.ts:152 (`RETENTION_SHED_CLASS_PREDICATE`), :189, :249 (`computeColdWatermark` MAX(id)), :286-302 (`retainColdPayloads` NULL + cursor gate), :520 (`countAbsentBlobs`)
- test/refold-equivalence.test.ts — the proof to extend (rewindAndWipeProjections, differential re-fold)
- src/db.ts:49 (SCHEMA_VERSION=84), :2095 (downgrade guard), migration ladder; keeper/api.py:361 (SUPPORTED_SCHEMA_VERSIONS); test/schema-version.test.ts (enforces the same-commit bump)

### Risks

- Re-fold determinism is sacred. If a from-scratch re-fold over the post-DELETE rows is NOT byte-identical, DO NOT ship the physical delete — stop at stage 1 (mark only, rows intact) and surface. The proof is the hard gate, not a formality.
- py/binary version skew on the SCHEMA_VERSION bump (downgrade guard rejects a newer DB on an old binary) — sequence the rollout.
- A long-lived read txn pins the WAL during the delete; batch + checkpoint and run in the writer process.
- Must never delete a row inside T4's computeMonitors bound (hence deps T4 — reconcile watermarks).

### Test notes

The extended refold-equivalence proof IS the acceptance gate — it must actually run the
DELETE then re-fold (not merely re-NULL). Plus compaction.test.ts for the batched
delete/checkpoint/vacuum mechanics and the countAbsentBlobs re-spec. `bun run test:full`.

## Acceptance

- [ ] Extended refold-equivalence proof passes: a corpus with EVERY shed-class type, DELETE pass applied, two from-scratch re-folds byte-identical, AND no deleted id changes any fold's count/output. (If it fails, the physical delete is NOT shipped — stage 1 only.)
- [ ] No fold/producer reads `events` by COUNT/MAX(id)/id-contiguity in a way a deleted shed-class row would change (audit documented).
- [ ] SCHEMA_VERSION bumped 84→85 with `is_shed_deleted`; SUPPORTED_SCHEMA_VERSIONS bumped in the SAME commit (schema-version.test.ts green); migration is a cheap column-add.
- [ ] Physical DELETE is batched + `wal_checkpoint`ed + `incremental_vacuum`ed in keeper's writer process; `countAbsentBlobs` re-spec'd (absent shed row ≠ data loss; absent keep-set row still is); keeper.db row growth bounded.
- [ ] README compaction + CLAUDE.md retention invariant updated (forward-facing); `bun run test:full` green.

## Done summary

## Evidence
