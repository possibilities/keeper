## Description

**Size:** M
**Files:** src/db.ts, src/reducer.ts, src/collections.ts, src/types.ts, keeper/api.py, README.md, test/reducer.test.ts, test/schema-version.test.ts, test/db.test.ts

The keystone: the durable storage + event-sourcing layer everything else
builds on. Two new synthetic event types fold into projections, schema
bumps 61→62, and the new `armed_epics` collection becomes subscribable.
Clone the `AutopilotPaused`/`AutopilotCapSet` path verbatim.

### Approach

- **`AutopilotMode` event** (`event_type: "autopilot_state"`, reusing the singleton's shared type): payload `{ mode: "yolo" | "armed" }`. Add `extractAutopilotModePayload` (mirror `extractAutopilotPausedPayload` at reducer.ts:3900 — malformed/unknown-enum → return null → fold no-op, mode unchanged) and `foldAutopilotMode`: an `INSERT ... ON CONFLICT(id) DO UPDATE` on the `autopilot_state` singleton that sets `mode` + `last_event_id` + `updated_at` and PRESERVES `paused` + `max_concurrent_jobs` on conflict. The INSERT path must bind defaults for all NOT NULL columns.
- **`EpicArmed` event** (its OWN `event_type`, e.g. `"epic_armed"`, since `armed_epics` is a separate table from the singleton): payload `{ epic_id: string, armed: boolean }`. `foldEpicArmed` treats `armed_epics` as a PRESENCE table — `armed:true` → `INSERT OR REPLACE` the row; `armed:false` → `DELETE` the row. Malformed payload → no-op.
- **`applyEvent` switch** (reducer.ts:8055): add `else if` arms for `AutopilotMode` and `EpicArmed` before the final `else`.
- **Schema** (src/db.ts): add a `mode TEXT NOT NULL DEFAULT 'yolo'` column to `CREATE_AUTOPILOT_STATE` (db.ts:1535) so the zero-event projection = today's behavior. Add a `CREATE_ARMED_EPICS` table — presence table keyed by `epic_id` (`epic_id TEXT PRIMARY KEY, last_event_id INTEGER NOT NULL, created_at REAL NOT NULL, updated_at REAL NOT NULL`). Bump `SCHEMA_VERSION` 61→62.
- **Migration** (db.ts:5960-6022 block): `addColumnIfMissing(db, "autopilot_state", "mode", "TEXT NOT NULL DEFAULT 'yolo'")` — the ALTER literal must byte-match the bootstrap CREATE column ("Lockstep ALTER vs CREATE"). `db.run(CREATE_ARMED_EPICS)` for the new table. Stamp `schema_version`.
- **Collections** (src/collections.ts): add `mode` to `AUTOPILOT_STATE_DESCRIPTOR.columns` (:718-740). Add a new `ARMED_EPICS_DESCRIPTOR` (per-row) and REGISTER it in `REGISTRY` (:802-813) — this is the only step that makes the table subscribable/queryable over the UDS socket. All interpolated identifiers stay trusted constants (SQL-injection invariant).
- **keeper/api.py**: add `62` to the `SUPPORTED_SCHEMA_VERSIONS` frozenset (api.py:225) in this same change — `test/schema-version.test.ts` fails the build otherwise.
- **README.md**: add a v62 schema narrative block mirroring the v47 `autopilot_state` block (columns, fold semantics, re-fold determinism proof, boot invariant, keeper-py whitelist gain).

### Investigation targets

**Required** (read before coding):
- src/reducer.ts:3882-4057 — `AutopilotPausedPayload`/`extractAutopilotPausedPayload`/`foldAutopilotPaused` + `AutopilotCapSet` (the better template for a NEW singleton column: null-tolerance + column-preservation-on-conflict).
- src/reducer.ts:8055 — `applyEvent` switch dispatch.
- src/db.ts:1535-1544 — `CREATE_AUTOPILOT_STATE`; src/db.ts:5960-6022 — the v59→v60 `addColumnIfMissing` AND v60→v61 `CREATE TABLE IF NOT EXISTS` patterns + schema_version stamp.
- src/collections.ts:718-813 — `AUTOPILOT_STATE_DESCRIPTOR` + the `REGISTRY` registration.
- keeper/api.py:225 — `SUPPORTED_SCHEMA_VERSIONS` frozenset.
- test/reducer.test.ts:14707+ — fold + re-fold determinism pattern (mint helper, `getAutopilotState()` SELECT, UPSERT, created_at-preserved, malformed→safe no-op; re-fold rewind+DELETE+redrain — `armed_epics` MUST join the DELETE list).

**Optional** (reference as needed):
- README.md ~1549-1575 — the v47 schema narrative block to mirror.

### Risks

- Singleton column-preservation matrix is easy to get wrong: `foldAutopilotMode` must preserve `paused`+`max_concurrent_jobs`, and the existing `foldAutopilotPaused`/`foldAutopilotCapSet` must preserve `mode` — verify the boot re-arm INSERTs of paused (daemon.ts:1400) and cap (:1460), which are the FIRST writers to the singleton on a fresh DB, satisfy the NOT-NULL `mode` constraint (the `DEFAULT 'yolo'` covers them).
- Forgetting `armed_epics` in the re-fold DELETE list silently breaks the determinism test.

### Test notes

- Fold tests for both events: UPSERT/insert/delete semantics, `created_at` preserved across a mode flip, malformed payload → no row change + cursor still advances.
- Re-fold determinism: rewind cursor, `DELETE FROM autopilot_state` + `DELETE FROM armed_epics`, redrain → byte-identical rows.
- `test/schema-version.test.ts` green (62 in the whitelist).

## Acceptance

- [ ] `mode` column added to `autopilot_state` (default `'yolo'`); `armed_epics` presence table created; migration 61→62 idempotent and lockstep-matched.
- [ ] `AutopilotMode` + `EpicArmed` fold via `applyEvent`; malformed payloads no-op without throwing; cursor advances.
- [ ] `foldAutopilotMode` preserves `paused`+`max_concurrent_jobs`; sibling folds preserve `mode`.
- [ ] `ARMED_EPICS_DESCRIPTOR` registered in `REGISTRY`; `mode` in `AUTOPILOT_STATE_DESCRIPTOR`.
- [ ] `SUPPORTED_SCHEMA_VERSIONS` includes 62; `test/schema-version.test.ts` passes.
- [ ] Re-fold determinism holds with `armed_epics` in the DELETE list.

## Done summary

## Evidence
