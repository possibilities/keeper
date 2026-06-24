## Description

**Size:** M
**Files:** src/db.ts, keeper/api.py, src/reducer.ts, src/types.ts (event payload types), test/ (refold-equivalence + fold tests)

Add a deterministic-replayed `block_escalations` projection that is the escalate-once latch for the daemon escalation producer (task 3). Category-AGNOSTIC: the fold only tracks whether a task is blocked and whether escalation has been requested/attempted — the category gate lives in the producer (task 3), not here.

### Approach

Clone the `dispatch_never_bound` shape. Table `block_escalations(epic_id TEXT, task_id TEXT, blocked_since INTEGER, status TEXT, outcome TEXT, last_event_id INTEGER, PRIMARY KEY(epic_id, task_id))` in `src/db.ts`, DDL modeled on `CREATE_DISPATCH_NEVER_BOUND` (src/db.ts:1124-1132). Bump `SCHEMA_VERSION` 85→86 (line 49) and add 86 to `keeper/api.py` `SUPPORTED_SCHEMA_VERSIONS` in the SAME commit (test/schema-version.test.ts enforces). Add `block_escalations` to ALL FIVE rewinding-migration wipe blocks (src/db.ts:3538,4418,4668,4733,5049) as a plain `DELETE` (it is deterministic-replayed, NOT live-only — do not use `rewindLiveProjection`).

Fold arms in `src/reducer.ts` (model on `foldDispatchExpired`, 3857-3932 — reads only `event.id`/`event.ts`, never wall-clock/fs/liveness):
- On a `TaskSnapshot` fold where the task transitions INTO `runtime_status="blocked"` and no latch row exists: insert a latch row with `blocked_since = event.id`, `status="pending"`. (The latch row IS the prev-value; reset is deterministic.)
- On a `TaskSnapshot` fold where `runtime_status` leaves `"blocked"`: DELETE the latch row (so an unblock→re-block re-escalates exactly once — the `dispatch_never_bound` bind/clear reset analog).
- On `BlockEscalationRequested{epic_id, task_id}`: set `status="requested"`.
- On `BlockEscalationAttempted{epic_id, task_id, outcome}`: set `status="attempted"`, record `outcome`.

Add the two new event payload types to `src/types.ts`. These events ARE read by the fold, so they stay in the KEEP-SET inline forever (complement of the shed allow-list) — do NOT add them to the retention shed predicate.

### Investigation targets

**Required** (read before coding):
- src/reducer.ts:3857-3932 — `foldDispatchExpired` (the latch clone source: UPSERT/DELETE per-key, event.id/event.ts only, alreadyFailed skip-arm).
- src/db.ts:1124-1132 — `CREATE_DISPATCH_NEVER_BOUND` DDL + the re-fold-deterministic doc block (1109-1122).
- src/db.ts:49,3538,4418,4668,4733,5049 — SCHEMA_VERSION + the five wipe blocks.
- src/reducer.ts:625-663 — the TaskSnapshot fold element + runtime_status handling (444-447,710); the slot-order comment (627-632) explains why we are NOT adding a projected column here.
- keeper/api.py:361 — `SUPPORTED_SCHEMA_VERSIONS`.

**Optional:**
- test/ files referencing `dispatch_never_bound`/`DispatchExpired` — the test clone targets.

### Risks

- Re-fold divergence: any wall-clock/fs/liveness read inside the fold breaks the byte-identical charter. Keep all of it in the producer (task 3).
- Missing one of the five wipe blocks → a cursor-rewind migration leaves the projection stale forever.
- Schema bump without the api.py companion → `test/schema-version.test.ts` fails.

### Test notes

Add a refold-equivalence test mirroring the `dispatch_never_bound` one: fold a synthetic stream (block→requested→attempted→unblock→re-block), then re-fold from scratch and assert byte-identical `block_escalations` rows. Use `freshDb()`/`freshDbFile()` for in-process schema. Cover the unblock→re-block re-arm and the pending→requested→attempted transitions.

## Acceptance

- [ ] `block_escalations` table created; SCHEMA_VERSION=86; keeper/api.py updated in the same commit.
- [ ] Fold sets the latch with `blocked_since=event.id` on entering blocked, deletes on leaving blocked, advances pending→requested→attempted on the escalation events.
- [ ] Added to all five rewinding-migration wipe blocks as a plain DELETE.
- [ ] Refold-equivalence test green; the fold reads no wall-clock/fs/liveness.
- [ ] `bun run test:full` green.

## Done summary

## Evidence
