## Description

**Size:** M
**Files:** src/db.ts, src/plan-worker.ts, src/daemon.ts, src/reducer.ts, src/collections.ts, src/types.ts, scripts/board.ts, test/reducer.test.ts, test/plan-worker.test.ts

### Approach

End-to-end vertical slice: add `last_validated_at` to every layer of the epic data path so `scripts/board.ts` can read it from the `result` frame and render a pill.

1. **Schema (src/db.ts)** — bump `SCHEMA_VERSION` from 13 to 14 at line 47; append `last_validated_at TEXT` to the `CREATE_EPICS` literal at lines 299-313 (no DEFAULT — nullable is the honest zero-event value); add an idempotent `addColumnIfMissing(db, "epics", "last_validated_at", "TEXT")` step in `migrate()` adjacent to the v13 `approval` add at line 777. No version guard, no backfill, no rewind-and-redrain — the plan-worker's per-boot re-scan repopulates everything from disk via the change-gate.
2. **RawEpic / PlanEpicMessage (src/plan-worker.ts)** — add `last_validated_at?: unknown` to `RawEpic` (lines 291-299); add `lastValidatedAt: string | null` to `PlanEpicMessage` (lines 99-116); emit `lastValidatedAt: asString(raw.last_validated_at)` in `buildEpicMessage` (lines 682-705). `asString` collapses missing/null/empty-string/non-string values to `null` uniformly (the "safe value" CLAUDE.md invariant).
3. **seedFromDb symmetry (src/plan-worker.ts:831-872)** — KEYSTONE. Add `last_validated_at` to the SELECT at line 843; add `lastValidatedAt: asString(e.last_validated_at)` to the reconstructed message literal at lines 856-871, IN THE SAME OBJECT-LITERAL POSITION as `buildEpicMessage` returns it. Mismatched field ordering produces a JSON.stringify diff every restart → one synthetic `EpicSnapshot` re-emit per epic, forever.
4. **Daemon (src/daemon.ts:340-348)** — synthetic-event blob construction: add `last_validated_at: msg.lastValidatedAt` to the camelCase→snake_case mapping site.
5. **Reducer (src/reducer.ts)** — add `last_validated_at?: string | null` to `PlanSnapshot` (lines 293-311); add the column to BOTH the `INSERT INTO epics (...)` column list AND the `ON CONFLICT(epic_id) DO UPDATE SET ... last_validated_at = excluded.last_validated_at` clause at the EpicSnapshot fold site (lines 367-405); bind `snapshot.last_validated_at ?? null` in the param array. Do NOT modify the shell-row INSERTs at lines 510, 759, 853 — the schema default of NULL is correct for shell rows, and the embedded shape under `syncJobIntoEpic` is the TASK element (no `last_validated_at` field at task level).
6. **Descriptor (src/collections.ts:158-218)** — add `"last_validated_at"` to `EPICS_DESCRIPTOR.columns`. Do NOT add to `sortable`, `filters`, or `jsonColumns` (it's a plain TEXT scalar; `decodeRow` would corrupt it if listed in `jsonColumns`).
7. **Types (src/types.ts:193-217)** — add `last_validated_at: string | null` to the `Epic` interface.
8. **Render (scripts/board.ts)** — add `validatedPill(v: unknown): "validated" | "unvalidated"` adjacent to `approvalPill` at lines 150-158. Predicate: `v != null ? "validated" : "unvalidated"` (matches `approvalPill` style; `asString` already collapses empty-string at the producer boundary). Append to the epic header line in `renderEpicBlock` at line 308: `${dirSeg}${seg(row.epic_number)} ${seg(row.title)}${epicDepsSeg} [${validatedPill(row.last_validated_at)}]`. Header-line only — task rows unchanged.

Open question (deferred from Nice-to-Clarify): should `last_validated_at` ever be exposed as `sortable` on the descriptor? Not in this task — model is "render boolean today, future task may add sortable if a use case appears."

### Investigation targets

**Required** (read before coding):

- src/db.ts:47 — `SCHEMA_VERSION` constant; bump 13 → 14.
- src/db.ts:299-313 — `CREATE_EPICS` literal; append the column.
- src/db.ts:385-398 — `addColumnIfMissing` helper signature + PRAGMA table_info guard pattern.
- src/db.ts:777-782 — v12→v13 approval add slot; place v13→v14 step adjacent.
- src/db.ts:636-640 — bun#1332 statement-cache pin note; only relevant if reading the new column inside the migrate transaction (none expected).
- src/plan-worker.ts:99-116 — `PlanEpicMessage` shape.
- src/plan-worker.ts:291-299 — `RawEpic` shape.
- src/plan-worker.ts:313-358 — `asString`/`coerceApproval`/`asStringArray` safe-value primitives.
- src/plan-worker.ts:682-705 — `buildEpicMessage`; producer-side field-position anchor.
- src/plan-worker.ts:831-872 — `seedFromDb`; change-gate keystone — SELECT at line 843, message reconstruction at lines 856-871.
- src/daemon.ts:340-348 — camelCase→snake_case mapping for the synthetic event blob.
- src/reducer.ts:283-340 — `PlanSnapshot` + `extractPlanSnapshot` pattern.
- src/reducer.ts:367-405 — EpicSnapshot fold site (INSERT + ON CONFLICT UPDATE).
- src/collections.ts:158-218 — `EPICS_DESCRIPTOR` definition.
- src/types.ts:193-217 — `Epic` interface.
- scripts/board.ts:150-158 — `approvalPill` (template for `validatedPill`).
- scripts/board.ts:290-333 — `renderEpicBlock` (especially the header line at :308).
- CLAUDE.md — event-sourcing invariants (re-fold byte-identity, producer-only writes, safe-value rule).

**Optional** (reference as needed):

- test/reducer.test.ts:2388-2502 — synthetic event construction + drainAll + re-fold determinism templates.
- test/plan-worker.test.ts:102-206 — direct `buildEpicMessage` call + approval-coercion templates.
- test/plan-worker.test.ts:592 — `seedFromDb reconstructs approval field-identically` template — model the new symmetry test on this.
- test/rpc-handlers.test.ts:87 — fixture already names `last_validated_at: "2026-05-24T00:00:00Z"` (will start being satisfied for free once the projection ships the field).

### Risks

- **seedFromDb field-position drift (keystone)** — if the reconstructed message places `lastValidatedAt` in a different object-literal slot than `buildEpicMessage`, `JSON.stringify` produces a different byte sequence and the change-gate triggers a synthetic `EpicSnapshot` re-emit per epic on every daemon restart. Mitigation: same task lands BOTH edits; reviewer checklist; plan-worker symmetry test catches a regression byte-for-byte.
- **`asString` on non-string disk values** — a malformed planctl file with `"last_validated_at": 42` or `true` should collapse to `null`. Confirm via `asString` (src/plan-worker.ts:313).
- **`jsonColumns` confusion** — adding the new column to `jsonColumns` would make `decodeRow` `JSON.parse` a raw ISO timestamp and fall back to `[]`. Pin: NOT a JSON column.

### Test notes

Two focused additions:

1. **Reducer round-trip** in `test/reducer.test.ts`: an `EpicSnapshot` event with `last_validated_at: "2026-05-24T00:00:00Z"` writes the column. A from-scratch re-fold (rewind cursor + DELETE FROM epics + drainToCompletion) reproduces the same column value byte-identically. Use the existing synthetic-event template near line 2388.
2. **Plan-worker seedFromDb symmetry** in `test/plan-worker.test.ts`: build a `PlanEpicMessage` via `buildEpicMessage({...with last_validated_at...})`, serialize via `JSON.stringify`. Then seed an epics row, call `seedFromDb`, intercept the reconstructed message, serialize via `JSON.stringify`. The two byte sequences must match. Use the existing `seedFromDb reconstructs approval field-identically` test (line 592) as the template.

## Acceptance

- [ ] `SCHEMA_VERSION = 14`; fresh DB and migrated DB both end with `last_validated_at TEXT` on `epics`.
- [ ] `buildEpicMessage` emits `lastValidatedAt: asString(raw.last_validated_at)`; `seedFromDb` reconstructs the same field in the same object-literal position (verified by JSON.stringify symmetry test).
- [ ] Synthetic `EpicSnapshot` event blob carries `last_validated_at` (snake_case) at the daemon mapping site.
- [ ] Reducer EpicSnapshot fold writes the column on INSERT AND refreshes it on ON CONFLICT DO UPDATE.
- [ ] `EPICS_DESCRIPTOR.columns` includes `"last_validated_at"`; `jsonColumns` does NOT.
- [ ] `Epic` interface has `last_validated_at: string | null`.
- [ ] `scripts/board.ts` `renderEpicBlock` header line ends with `[${validatedPill(row.last_validated_at)}]`; pill renders `validated` when timestamp present, `unvalidated` when null/missing.
- [ ] Reducer round-trip test passes (EpicSnapshot writes column; re-fold reproduces byte-identical row).
- [ ] Plan-worker `seedFromDb` symmetry test passes (`buildEpicMessage` output == `seedFromDb` output, byte-for-byte).
- [ ] Daemon restart on a populated DB does NOT log any synthetic `EpicSnapshot` re-emit (verify locally: run keeperd, kill, restart, check the change-gate).
- [ ] Existing `test/rpc-handlers.test.ts:87` fixture continues to pass without modification.

## Done summary

## Evidence
