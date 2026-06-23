## Description

**Size:** M
**Files:** src/reducer.ts

The determinism keystone: the new `TmuxTopologySnapshot` fold (sole owner of live location),
the `(generation_id, pane_id)` recycle guard, the env→birth precedence flip, and retiring the
two old folds to explicit no-op arms.

### Approach

Add `foldTmuxTopologySnapshot` + a null-safe `extractTmuxTopologySnapshot` decoder (copy the
never-throw, per-entry type-narrow skeleton from `extractWindowIndexSnapshot`, reducer.ts:3179).
Wire a new `else if (event.hook_event === "TmuxTopologySnapshot")` arm in `applyEvent`
(reducer.ts:7607-7665). The fold, gated `if (event.id <= readTmuxFloor(db)) return;` (add a
module-local `readTmuxFloor` twin beside `readGitFloor` ~reducer.ts:1810): for each pane in the
payload, UPDATE the matching LIVE tmux job — match on `backend_exec_pane_id = pane_id` AND
(`backend_exec_generation_id = snapshot.generation_id` OR `backend_exec_generation_id IS NULL`);
on a NULL-generation match, ADOPT the snapshot generation (first-match stamping). OVERWRITE
`backend_exec_session_id` + `window_index` ONLY with present, non-NULL values (a NULL/garbage
window_index or absent pane leaves the last-known value — preserve, never wipe). Pure: reads only
the payload + in-txn rows, never probes/clock/env.

Precedence flip: in the env COALESCE arm (reducer.ts:7309-7327), STOP writing
`backend_exec_session_id`; route that env value to `backend_exec_birth_session_id` instead
(COALESCE-fill: birth is written once and not re-clobbered — or keep COALESCE, it's idempotent
since the env is constant per process). `backend_exec_pane_id` + `backend_exec_type` stay as-is.

Retire the old folds: `foldTmuxPaneSnapshot` (reducer.ts:3142) and `foldWindowIndexSnapshot`
(reducer.ts:3235) — convert their `applyEvent` arms to EXPLICIT no-op arms (like
`BackendExecSnapshot` at reducer.ts:7637). NEVER delete the arms: a deleted arm routes historical
`TmuxPaneSnapshot`/`WindowIndexSnapshot` events into the final `else` → `projectJobsRow` and
breaks re-fold. The producer no longer posts those kinds (task 2), but historical events remain
in the log forever.

### Investigation targets

**Required** (read before coding):
- src/reducer.ts:7309-7327 — env COALESCE arm (stop writing session → birth)
- src/reducer.ts:7607-7665 — `applyEvent` fold-arm dispatch + the `BackendExecSnapshot` no-op precedent (:7637)
- src/reducer.ts:1810-1824 — module-local `readGitFloor` + `projectGitStatus` floor-gate (mirror as readTmuxFloor)
- src/reducer.ts:3142 `foldTmuxPaneSnapshot`, :3179 `extractWindowIndexSnapshot` decoder, :3235 `foldWindowIndexSnapshot` (retire + decoder template)
- src/db.ts — the tmux floor accessor added in task 1 (for the module-local twin to read)

**Optional** (reference as needed):
- src/reducer.ts:3122-3158 — the fill-only fold's order-insensitive doc (contrast with the new overwrite semantics)

### Risks

- Deleting (vs no-op-ing) a retired event arm silently breaks re-fold determinism — the single
  sharpest correctness trap here.
- The recycle guard must not adopt a generation for a NON-live (killed) job — filter on live status.
- An overwrite that nulls a good window_index on a NULL-in-payload breaks crash-restore sorting.

### Test notes

In-process (`freshDb()` + synthetic events): a TmuxTopologySnapshot moves a live job's
session+window; a second snapshot with a NEW generation_id does NOT overwrite an old-generation
job (recycle guard); an absent pane / NULL index preserves last-known; a below-floor event is a
no-op. Re-fold equivalence: replaying history (incl. historical TmuxPaneSnapshot/WindowIndexSnapshot)
reproduces byte-identical rows for all non-live-only columns.

## Acceptance

- [ ] `foldTmuxTopologySnapshot` overwrites `backend_exec_session_id` + `window_index` for live
      jobs matched on `(generation_id, pane_id)`, gated above the tmux floor, never throwing.
- [ ] A new-generation snapshot never overwrites a prior-generation job; NULL-generation jobs
      adopt the snapshot generation on first match.
- [ ] Absent panes and NULL/garbage indices preserve the last-known good value.
- [ ] The env COALESCE arm writes `backend_exec_birth_session_id`, not the live session.
- [ ] `TmuxPaneSnapshot` + `WindowIndexSnapshot` arms are explicit no-ops (not deleted); re-fold
      stays byte-identical for non-live-only columns.

## Done summary
Added foldTmuxTopologySnapshot as the sole owner of live tmux location: overwrites backend_exec_session_id + window_index for live jobs matched on (generation_id, pane_id), gated above the tmux skip-floor, recycle-guarded, preserving last-known on absent panes / NULL indices. Flipped the env arm to forensic birth_session_id and retired the TmuxPaneSnapshot + WindowIndexSnapshot folds to explicit no-op arms.
## Evidence
