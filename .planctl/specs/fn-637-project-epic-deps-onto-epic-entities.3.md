## Description

**Size:** M
**Files:** src/reducer.ts, src/db.ts (migrate-time backfill), test/reducer.test.ts

The keystone. Maintain `resolved_epic_deps` + `epic_dep_edges` as a pure
function of the event log, inside the existing `BEGIN IMMEDIATE` fold.

### Approach

Build ONE shared `enrichEpicDep` helper (mirror `enrichJobLink`): given a
`dep_token` and an all-epics index assembled from SQLite mid-fold, call the
task-.1 `resolveEpicDep` (no-op diagnostics sink, no wall-clock) and produce the
minimal-subset entry `{dep_token, resolved_epic_id, epic_number,
project_basename, cross_project, state}` with `state` one of `satisfied`
(resolved AND status=done AND approval=approved), `blocked-incomplete` (resolved
AND not-that), or `dangling` (unresolved). Locked key order; never throws.

Forward + reverse + delete share this helper. Full-recompute, never delta-merge
(mirror `syncPlanctlLinks`). Deterministic ORDER BY consumer_id. Depth-1 only —
never recurse inside the fold.

### Detailed phases

1. **Index assembly + enrichEpicDep.** A read-during-fold helper that SELECTs
   the candidate epics (by full id and by `epic_number`) the resolver needs, plus
   `enrichEpicDep`. (Read-in-fold is allowed; the autocommit ban is only on DB
   watchers.)
2. **Forward stamp (EpicSnapshot for consumer B).** After B's row INSERT/UPDATE
   in `projectPlanRow`: delete B's `epic_dep_edges` rows, insert one per
   `dep_token` in B.`depends_on_epics`, then stamp B.`resolved_epic_deps`. Add
   `resolved_epic_deps` to the `EpicSnapshot` ON CONFLICT carve-out (reducer.ts
   ~553-583) so an approval-RPC round-trip cannot wipe it.
3. **Reverse fan-out (EpicSnapshot + EpicDeleted for upstream A).** On any write
   to A, `SELECT consumer_id FROM epic_dep_edges WHERE dep_token IN (A.epic_id,
   'fn-' || A.epic_number)` (ORDER BY consumer_id), re-resolve + re-stamp each
   consumer. EpicDeleted re-stamps consumers to dangling. This handles bare-id
   ambiguity flips (a new same-number epic's own snapshot fans out to all `fn-N`
   consumers).
4. **Migrate-time backfill (src/db.ts).** Version-guarded, chunked
   (`WHERE ... LIMIT N` loop, intermediate commits) BEFORE the daemon serves:
   re-derive `epic_dep_edges` + `resolved_epic_deps` for existing rows. No
   mega-transaction WAL lock.
5. **Re-fold determinism test.** Rewind cursor, `DELETE FROM epics; DELETE FROM
   epic_dep_edges`, re-drain, assert byte-identical (mirror reducer.test.ts:1690).

### Investigation targets

**Required**:
- src/reducer.ts:552-607 — `projectPlanRow` EpicSnapshot fold + ON CONFLICT carve-out (:553-583), `depends_on_epics` store (:599)
- src/reducer.ts:2799-2834 (`enrichJobLink`), :2880-2978 (`syncJobLinksOnJobWrite` reverse fan-out), :3026-3420 (`syncPlanctlLinks` full-recompute), :2733/:2754 (sort helpers)
- test/reducer.test.ts:1690, :1768-1771 — re-fold byte-identity pattern
- src/epic-deps.ts (task .1) — `resolveEpicDep` with injected timestamp

**Optional**:
- src/reducer.ts:2857-2862 — the json_each anti-pattern note (why we use the edges table)

### Risks

- **Re-fold determinism** — no `Date.now()`/env in the fold; deterministic sort; full-recompute. This is the gate; if it cannot pass, the epic's fallback (keep fn-637) triggers.
- **WAL contention** — a wide fan-out holds the write lock; keep the reverse lookup index-driven and depth-1.
- **Bare-id reverse correctness** — the `dep_token IN (id, fn-number)` lookup must catch both full-id and bare-id consumers.
- **EpicDeleted ordering** — deleting A must re-stamp consumers in the same fold.

### Test notes

- Re-fold byte-identity after rewind+DELETE+re-drain.
- Completing an upstream re-stamps downstream to `satisfied` in the same fold (the core bug).
- New same-number epic flips a bare-id consumer to `dangling` (ambiguity).
- EpicDeleted re-stamps consumers to `dangling`.
- Backfill re-derives existing rows; idempotent on re-run.

## Acceptance

- [ ] `enrichEpicDep` shared by forward, reverse, and delete paths; produces the minimal-subset tri-state entry; never throws; locked key order.
- [ ] Forward fold rebuilds `epic_dep_edges` + stamps `resolved_epic_deps`; `resolved_epic_deps` added to the EpicSnapshot ON CONFLICT carve-out.
- [ ] Reverse fan-out (EpicSnapshot + EpicDeleted) re-stamps downstream consumers via the `dep_token IN (id, fn-number)` lookup, depth-1, full-recompute, deterministic order, all in the one `BEGIN IMMEDIATE`.
- [ ] Version-guarded chunked backfill in `migrate()` before serving; no mega-transaction.
- [ ] Re-fold determinism test passes byte-identical; no wall-clock/env in the fold.

## Done summary

## Evidence
