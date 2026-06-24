## Description

**Size:** S
**Files:** src/compaction.ts, test/compaction.test.ts, test/refold-equivalence.test.ts

### Approach

`TmuxTopologySnapshot` is restore's source of truth but survives compaction only INCIDENTALLY — it is in neither `RETENTION_SHED_CLASS_PREDICATE` (shed/body-NULL) nor `NOOP_SNAPSHOT_DELETE_PREDICATE` (row-delete), so a future widen of either allow-list could silently delete the anchor the deriver reads. Make retention EXPLICIT: add a positive, class-level keep invariant that retains `TmuxTopologySnapshot` rows AND bodies unconditionally (the body carries the panes + `job_id` the deriver reads). Keep it cheap-column-expressible — a class-name gate, never `json_extract`. This sidesteps a generation-aware "last N" predicate (which would require a new indexed `generation_id` column) — snapshots are small and change-gated, so unconditional retention is cheap; a generation-aware prune is a deferred follow-up only if accumulation is ever observed.

### Investigation targets

**Required** (read before coding):
- src/compaction.ts:152 — `RETENTION_SHED_CLASS_PREDICATE` (positive shed allow-list; the complement is the keep-set)
- src/compaction.ts:230 — `NOOP_SNAPSHOT_DELETE_PREDICATE` (the row-delete allow-list `TmuxTopologySnapshot` must stay out of)
- test/compaction.test.ts:124 — `projectionSnapshot` re-fold-compare seeding pattern
- test/refold-equivalence.test.ts — pins the physical-delete set; confirm adding the explicit keep does not perturb it

### Risks

- `TmuxTopologySnapshot` is a LIVE-ONLY skip-floored fold arm: a historical (id ≤ floor) snapshot no-ops on re-fold and would otherwise be delete-safe — the explicit keep must dominate so restore's source survives regardless of the floor.
- Touching the delete/keep predicates shifts the `refold-equivalence` pinned set — update that test deliberately, not incidentally.

### Test notes

Add a test asserting a `TmuxTopologySnapshot` body+row survives a retention pass that sheds/deletes its neighbors, and that re-fold equivalence still holds. Run `bun run test:full`.

## Acceptance

- [ ] `TmuxTopologySnapshot` rows AND bodies are retained by an explicit class-level keep invariant (no `json_extract` in the gate)
- [ ] A retention pass that sheds/deletes neighboring classes leaves `TmuxTopologySnapshot` intact
- [ ] `refold-equivalence` pinned set updated deliberately; re-fold equivalence holds
- [ ] Test proves the snapshot survives compaction; `bun run test:full` green

## Done summary

## Evidence
