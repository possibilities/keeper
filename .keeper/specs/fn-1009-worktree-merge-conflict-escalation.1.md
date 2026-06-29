## Description

**Size:** M
**Files:** src/db.ts, src/reducer.ts, src/types.ts, src/collections.ts, keeper/api.py, test/refold-equivalence.test.ts, test/schema-version.test.ts, test/reducer-projections.test.ts

The event-sourcing foundation the daemon sweep (task .2) rides on: a once-marker
column on `dispatch_failures` plus a `MergeEscalationAttempted` synthetic event
that folds it. Built and re-fold-tested in isolation so the determinism risk is
retired before the producer is added.

### Approach

Add a nullable `merge_escalated_at` (REAL, epoch seconds) column to
`dispatch_failures` via a version-guarded `addColumnIfMissing` step in `migrate`
(`src/db.ts:2199`) — NOT by editing the CREATE-table literal. Bump
`SCHEMA_VERSION` (96→97) and add 97 to `SUPPORTED_SCHEMA_VERSIONS` in
`keeper/api.py` in the SAME commit, with a one-line `# vNN (...)` provenance
comment matching the existing style. Add a `MergeEscalationAttempted` event:
a payload type in `src/types.ts` alongside the `BlockEscalation*` payloads, a
route in the `applyEvent` `hook_event` switch (`src/reducer.ts:8546-8557`), and a
`foldMergeEscalationAttempted` that, for a TERMINAL outcome (`sent` or
`queued_for_wake`), `UPDATE dispatch_failures SET merge_escalated_at = <event.ts>
WHERE verb='close' AND id=<payload.id> AND merge_escalated_at IS NULL`; a
`send_failed` outcome folds to a no-op (leaves NULL → re-sweepable), mirroring
`foldBlockEscalationAttempted`'s `send_failed`-is-non-terminal rule
(`src/reducer.ts:4127`). The UPDATE no-ops on a missing row (clear-before-mint
race). In `foldDispatchFailed` (`src/reducer.ts:3712`), include
`merge_escalated_at` in the row but PRESERVE it across the `ON CONFLICT` (exclude
it from the SET clause, exactly like `created_at` at `:3726`) so a re-UPSERT of an
uncleared row never resets the marker; a `DispatchCleared` DELETE drops the marker
with the row so a fresh conflict re-arms at the column default (NULL). Expose the
column on `DISPATCH_FAILURES_DESCRIPTOR` (`src/collections.ts:573`).

### Investigation targets

**Required** (read before coding):
- src/db.ts:49 — `SCHEMA_VERSION` (currently 96; bump to 97).
- src/db.ts:1061 — the `dispatch_failures` CREATE schema (do NOT edit; add the column via migration).
- src/db.ts:1925 — `addColumnIfMissing` (the idempotent ALTER helper).
- src/db.ts:2199 — `migrate` (add a new version-guarded step).
- src/reducer.ts:3712 — `foldDispatchFailed`; `created_at` preservation across `ON CONFLICT` at `:3726` is the pattern to copy for the marker.
- src/reducer.ts:4122 — `foldBlockEscalationAttempted`; `send_failed`-is-non-terminal at `:4127`.
- src/reducer.ts:8546 — the `applyEvent` `hook_event` routing switch (add the new event tag).
- src/types.ts:926 — `BlockEscalation*` payload interfaces (add the new payload type alongside).
- src/collections.ts:573 — `DISPATCH_FAILURES_DESCRIPTOR`.
- keeper/api.py:385 — `SUPPORTED_SCHEMA_VERSIONS` (+ provenance comment style).

**Optional** (reference as needed):
- src/db.ts:3663, :4557, :4809, :4876, :5194 — the projection-wipe DELETE lists; confirm `dispatch_failures` is already present so a COLUMN needs no new entry (a new TABLE would).

### Risks

Re-fold determinism is the load-bearing risk: the fold must read ONLY `event.ts`
/ payload + the persisted row — no wall-clock, fs, env, or liveness. A re-fold of
`{DispatchFailed, MergeEscalationAttempted(sent)}` must reproduce
`merge_escalated_at` byte-identically with zero side effect. The two subtle bits
are the UPSERT-preserve (don't reset the marker on a re-failure of an uncleared
row) and the `send_failed`→NULL no-op.

### Test notes

Re-fold byte-equivalence for a stream containing the new event
(`test/refold-equivalence.test.ts` — MUST). `SUPPORTED_SCHEMA_VERSIONS` bump
(`test/schema-version.test.ts`). Fold unit cases: terminal outcome sets the
timestamp; `send_failed` leaves NULL; missing-row UPDATE no-ops; a `DispatchFailed`
re-UPSERT preserves an existing marker; `DispatchCleared` drops it; a malformed
payload folds to a safe no-op (never throws, cursor advances). Use
`freshMemDb()` / `freshDbFile()`.

## Acceptance

- [ ] `dispatch_failures` gains a nullable `merge_escalated_at` column via a version-guarded migration step (not the CREATE literal).
- [ ] `SCHEMA_VERSION` bumped to 97 and added to `SUPPORTED_SCHEMA_VERSIONS` in `keeper/api.py` in the same commit; `test/schema-version.test.ts` green.
- [ ] `MergeEscalationAttempted` folds: a terminal outcome (`sent`/`queued_for_wake`) sets `merge_escalated_at = event.ts`; `send_failed` leaves it NULL; a missing-row UPDATE no-ops.
- [ ] `foldDispatchFailed` preserves `merge_escalated_at` across `ON CONFLICT` (a re-UPSERT of an uncleared row does not reset it); `DispatchCleared` drops it with the row.
- [ ] Re-fold byte-equivalence holds for a stream containing the new event (`test/refold-equivalence.test.ts`).
- [ ] The fold never throws on a malformed payload (folds to a safe no-op; cursor still advances).

## Done summary
Added the nullable dispatch_failures.merge_escalated_at escalate-once marker (schema v97->v98) folded by a new MergeEscalationAttempted synthetic event: a terminal outcome (sent/queued_for_wake) stamps it = event.ts, send_failed/unknown leaves NULL (re-sweepable), foldDispatchFailed preserves it across the UPSERT, DispatchCleared drops it. Re-fold byte-equivalence and the schema-version whitelist stay green.
## Evidence
