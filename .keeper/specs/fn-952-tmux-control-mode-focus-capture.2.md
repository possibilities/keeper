## Description

**Size:** M
**Files:** src/db.ts, src/reducer.ts, keeper/api.py, test/tmux-client-focus-fold.test.ts (new)

### Approach

The data-contract layer; lands independently of the producer (the fold + table exist with no
events yet).

- **Migration** (`src/db.ts`): bump `SCHEMA_VERSION` (db.ts:49) to the next available number
  (currently 86 → 87; if `fn-946` lands its bump first, use the next free number — these epics
  are dep-sequenced). Add `tmux_client_focus` via `CREATE TABLE IF NOT EXISTS` with
  `id INTEGER PRIMARY KEY CHECK (id = 1)`, `status TEXT`, `generation_id TEXT`, `session_name TEXT`,
  `window_index INTEGER`, `pane_id TEXT`, `last_event_id INTEGER`, `updated_at REAL`. Forward-only,
  no backfill. Register `tmux_client_focus` in `LIVE_ONLY_PROJECTIONS` (db.ts:1487) so a rewinding
  migration wipes it via `rewindLiveProjection`, never a bare DELETE. NO floor/seed singleton and
  NO boot-seed — this is a pure live-only singleton with no replay-worthy history; the worker is the
  sole source of truth and re-bootstraps on every connect.
- **Event + fold** (`src/reducer.ts`): add the `TmuxClientFocusSnapshot` payload interface
  `{ status, generation_id, session_name, window_index, pane_id }` + its extractor; `foldTmuxClientFocusSnapshot`
  does a last-write-wins UPSERT on `id = 1`, reading ONLY the payload + `event.ts` (never wall-clock/env/fs).
  Malformed payload → no-op, cursor still advances (never throw). NO floor gate. Route it in `applyEvent`
  (reducer.ts:7749 region) alongside the other snapshot arms.
- **Whitelist** (`keeper/api.py:361`): add the new version to the `SUPPORTED_SCHEMA_VERSIONS` frozenset in the SAME commit.

### Investigation targets

**Required** (read before coding):
- src/reducer.ts:3285 — `foldTmuxTopologySnapshot` as the fold/extractor shape to mirror (but SIMPLER: one-row UPSERT, no per-pane loop, no floor gate).
- src/db.ts:1224 / :1431 / :1456 — `autopilot_state` / `git_projection_state` / `tmux_projection_state` singleton DDL (`CHECK (id=1)`).
- src/db.ts:1487 — `LIVE_ONLY_PROJECTIONS`; src/db.ts:1563 — `rewindLiveProjection`.
- src/reducer.ts:7749 — `applyEvent` snapshot-arm routing.
- src/db.ts:49 — `SCHEMA_VERSION`; keeper/api.py:361 — `SUPPORTED_SCHEMA_VERSIONS`; test/schema-version.test.ts — the same-commit gate.

### Risks

- Schema-version collision with `fn-946` — sequenced via the epic dep; use the next-available number at implementation, don't hard-code.
- Throwing inside the fold wedges the reducer — malformed payload must no-op.

### Test notes

Fast-tier fold unit test with `freshDb()`: zero-event projection default, UPSERT idempotency /
last-write-wins, malformed-payload no-op + cursor advance. Keep `test/schema-version.test.ts` green.

## Acceptance

- [ ] `SCHEMA_VERSION` and `SUPPORTED_SCHEMA_VERSIONS` bumped together; `test/schema-version.test.ts` passes.
- [ ] `tmux_client_focus` singleton table (`CHECK id=1`) created forward-only and registered in `LIVE_ONLY_PROJECTIONS`; NO floor/seed table, NO boot-seed.
- [ ] `foldTmuxClientFocusSnapshot` UPSERTs id=1 last-write-wins, reads only payload + `event.ts`, no-ops on malformed input with the cursor advancing, and is routed in `applyEvent`.
- [ ] Fold unit test covers default / UPSERT / malformed-no-op.

## Done summary

## Evidence
