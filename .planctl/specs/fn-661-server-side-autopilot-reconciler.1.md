## Description

**Size:** M
**Files:** src/db.ts, src/reducer.ts, src/collections.ts, keeper/api.py, test/reducer.test.ts, test/schema-version.test.ts

### Approach

Add the durable substrate the reconciler writes to. Bump `SCHEMA_VERSION` 41→42
(`src/db.ts:60`) with a new ALTER slot (clone the v40→v41 block ~`:4076`, version
stamp ~`:4145`). Add a `dispatch_failures` projection table (template off
`CREATE_DEAD_LETTERS` `src/db.ts:982-996`): PK `(verb, id)`, columns `verb`,
`id`, `reason`, `dir`, `ts`, `last_event_id`, `created_at`, `updated_at`. Unlike
`dead_letters` it IS a reducer projection — it MUST be included in the re-fold
reset `DELETE FROM` list (~`src/db.ts:2016`) and rebuilt purely from the log.

Add two synthetic event types with pure fold arms inside the existing
`BEGIN IMMEDIATE` cursor+projection transaction (model on the Killed/Commit/
GitSnapshot arms in `src/reducer.ts`): `DispatchFailed{verb,id,reason,dir,ts}`
UPSERTs a row; `DispatchCleared{verb,id}` deletes the matching row. The fold is a
pure function of the event payload — no `Date.now()`, no liveness re-probe; the
worker stamps `reason`/`ts` at reconcile time and the event carries them. Register
a `DISPATCH_FAILURES` collection descriptor in `src/collections.ts` (mirror
`PROFILES_DESCRIPTOR:456`, `version: "last_event_id"`) so the viewer gets wire
diffs. Add 42 to `keeper/api.py` `SUPPORTED_SCHEMA_VERSIONS` (`:73`) in THIS change
— whitelist-only, no reader logic.

### Investigation targets

**Required** (read before coding):
- src/db.ts:60 — SCHEMA_VERSION constant
- src/db.ts:982-996 — CREATE_DEAD_LETTERS sidecar template (closest table shape)
- src/db.ts:1652 — migrate(); the v40→v41 ALTER slot ~:4076 and version stamp ~:4145 are the clone targets
- src/db.ts:~2016 — the re-fold reset DELETE FROM list (dispatch_failures MUST be added here)
- src/reducer.ts — synthetic-event fold arms (Killed / Commit / GitSnapshot precedents) inside BEGIN IMMEDIATE
- src/collections.ts:456 — PROFILES_DESCRIPTOR (collection descriptor template)
- keeper/api.py:73 — SUPPORTED_SCHEMA_VERSIONS frozenset
- test/schema-version.test.ts — the build gate that fails if the frozenset max < SCHEMA_VERSION

**Optional** (reference as needed):
- CLAUDE.md `## Event-sourcing invariants` — cursor+projection-in-same-transaction + re-fold determinism rules

### Risks

- dispatch_failures is a PROJECTION, not a sidecar — forgetting it in the re-fold reset DELETE breaks byte-identical re-fold. DispatchCleared (not a direct DELETE) is the only legal clear path.
- Fold-time wall-clock or liveness reads break re-fold determinism — keep the fold pure over the payload.
- Missing the keeper-py whitelist bump fails EVERY `jobctl commit-work` on the host.

### Test notes

- reducer.test.ts: fold DispatchFailed then DispatchCleared; assert projection state and that a from-scratch re-fold (rewind cursor, DELETE, re-drain) reproduces byte-identical rows.
- schema-version.test.ts passes with v42.
- Zero-event projection matches schema defaults (empty table).

## Acceptance

- [ ] SCHEMA_VERSION=42 with a forward-only ALTER adding `dispatch_failures`
- [ ] DispatchFailed UPSERTs and DispatchCleared deletes the `(verb,id)` row, both folded purely inside BEGIN IMMEDIATE
- [ ] dispatch_failures is in the re-fold reset list; a from-scratch re-fold reproduces it byte-identically
- [ ] DISPATCH_FAILURES collection descriptor registered (wire diffs work)
- [ ] keeper/api.py SUPPORTED_SCHEMA_VERSIONS includes 42; test/schema-version.test.ts passes

## Done summary
Schema v43 dispatch_failures projection (PK verb,id; reason/dir/ts/last_event_id/created_at/updated_at) plus DispatchFailed UPSERT and DispatchCleared DELETE fold arms inside BEGIN IMMEDIATE; table included in re-fold reset, DISPATCH_FAILURES collection descriptor registered, keeper-py SUPPORTED_SCHEMA_VERSIONS bumped to include 43. Substrate ready for the autopilot reconciler worker.
## Evidence
