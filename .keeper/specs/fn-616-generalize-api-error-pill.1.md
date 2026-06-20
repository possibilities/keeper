## Description

**Size:** M
**Files:** `src/db.ts`, `src/types.ts`, `src/reducer.ts`, `src/collections.ts`, `src/readiness.ts`, `test/db.test.ts`, `test/reducer.test.ts`, `test/board.test.ts` (factory defaults only), `test/readiness.test.ts`

### Approach

Land the schema bump and projection-shape change as one atomic move. After this task, the column `rate_limited_at` is gone, the new pair `(last_api_error_at, last_api_error_kind)` exists everywhere it needs to, and the reducer's dual-case fold writes both new columns for any `RateLimited` (legacy) or `ApiError` (forward-compat — no producer mints `ApiError` yet, but the arm is in place). The transcript matcher still emits `RateLimited` events only; nothing changes at the user-visible board layer yet (board.ts still reads the old field name — that's task .3's surface). The keystone here is re-fold determinism: a from-scratch re-fold under v24 produces byte-identical `epics.job_links[]` and `epics.tasks[].jobs[]` JSON arrays to what the live fold produces.

Order of operations inside the task (single PR, but logical sub-steps for review):

1. **Types first** (`src/types.ts`): widen `Job`, `EmbeddedJob`, `JobLinkEntry` to gain `last_api_error_at: number | null` + `last_api_error_kind: string | null`, drop `rate_limited_at`. JSDocs updated. Define and export the `ApiErrorKind` string-literal union as the canonical kind vocabulary: `"rate_limit" | "authentication_failed" | "billing_error" | "server_error" | "invalid_request" | "unknown"`.
2. **Reducer plumbing** (`src/reducer.ts`): widen `EmbeddedJobElement`, `JobsRowForSync`, `buildEmbeddedJob`, the `enrichJobLink` SELECT prefix at `:1608`, the helper at `:1716` (single source of truth for the entry shape — explicit NULL emission on the missing-row default; key order locked: `{kind, job_id, title, state, last_api_error_at, last_api_error_kind}`), and the `syncJobLinksOnJobWrite` trigger column set at `:1785-1875` (docstring at `:1744` updated to name both new columns).
3. **Reducer fold arm** (`src/reducer.ts:2388-2420`): rename `case "RateLimited"` to a dual-case form. Both labels route to the same handler. Compute `kind`: legacy `RateLimited` events force `kind = "rate_limit"`; new `ApiError` events read `event.data.kind` and validate against the `ApiErrorKind` union (anything else → `"unknown"`). Single compound UPDATE writes both columns plus the state flip-to-stopped. The terminal-row guard (`ENDED`/`KILLED` rows must NOT resurrect) is preserved verbatim. The `syncIfPlanRef` conditional call is preserved.
4. **Revival clear** (`src/reducer.ts:2277-2289`): `UserPromptSubmit` arm's UPDATE widens to `last_api_error_at = NULL, last_api_error_kind = NULL`. Paired clear — never one without the other.
5. **Schema migration** (`src/db.ts`): bump `SCHEMA_VERSION` from 23 → 24 at `:56`. Add the v23 → v24 migration block following the **v17→v18 rewind-and-redrain pattern** at `:1460-1500` (NOT the v20→v21 in-place re-derive at `:1820-1961` — embedded-JSON-shape changes force the rewind). The block:
   - `addColumnIfMissing(db, "jobs", "last_api_error_at", "REAL")`
   - `addColumnIfMissing(db, "jobs", "last_api_error_kind", "TEXT")`
   - Update the `CREATE_JOBS` literal at `:432` to declare both columns (the addColumnIfMissing/literal lockstep convention).
   - Drop `jobs.rate_limited_at` via `dropColumnIfPresent` (or whatever helper `src/db.ts:589` docstring references — verify before relying on it; SQLite 3.35+ also supports `ALTER TABLE … DROP COLUMN` natively, which Bun's bundled SQLite has).
   - `UPDATE reducer_state SET last_event_id = 0`
   - `DELETE FROM jobs`; `DELETE FROM epics`; `DELETE FROM subagent_invocations`
   - Version-guarded with `SELECT value FROM meta WHERE key='schema_version'` per the CLAUDE.md migration rule.
   The next boot drain re-folds from event 0 under v24 logic; historical `RateLimited` events fold via the dual-case alias.
6. **Collections** (`src/collections.ts:90-105`): swap `"rate_limited_at"` for `"last_api_error_at"` and add `"last_api_error_kind"` to the JOBS_DESCRIPTOR.columns list.
7. **Readiness JSDoc** (`src/readiness.ts:615`): doc-only rename of the enrichment-shape mention (no logic change — readiness doesn't branch on the column).
8. **Tests**: migration test for v23 → v24 in `test/db.test.ts` (mirror `test/db.test.ts:2965-3270` v20→v21 pattern: build v23-shaped DB by hand, seed jobs+epics with the old shape, close, `openDb()` triggers migration, assert widened shape). Update the sibling fresh-DB sentinel at `test/db.test.ts:3100` (`expect(ver.value).toBe("23")` → `"24"`). Replace all `rate_limited_at: null` fixture defaults across `test/reducer.test.ts`, `test/board.test.ts` (the `makeLink` / `makeEmbeddedJob` factories), `test/readiness.test.ts` (fixtures lines 97, 122, 134) with the two-field defaults. Update the existing `case "RateLimited"` test at `test/reducer.test.ts:3588-3625` so its assertions reference the new columns (the event_type stays `"RateLimited"` in this test — it's the dual-case alias coverage). Add a sibling test that mints an `ApiError` event with `data.kind = "rate_limit"` and asserts byte-identical projection rows to the `RateLimited` test — the dual-case alias correctness gate.

### Investigation targets

**Required** (read before coding):
- `src/db.ts:1460-1500` — v17→v18 rewind-and-redrain migration; THE template to mirror verbatim. The exact sequence of `addColumnIfMissing`, `UPDATE reducer_state SET last_event_id = 0`, and the three DELETEs.
- `src/reducer.ts:1693-1740` — `enrichJobLink` (the single source of truth — its docstring explains why three code paths must produce identical JSON). Note the explicit `{title: null, state: "stopped", rate_limited_at: null}` default literal on missing row.
- `src/reducer.ts:2388-2419` — current `case "RateLimited"` arm; the compound UPDATE pattern and the `(ENDED|KILLED)` terminal-row guard.
- `src/reducer.ts:2277-2289` — `UserPromptSubmit` revival UPDATE; the `rate_limited_at = NULL` clear that widens to a paired clear.
- `src/reducer.ts:1785-1875` — `syncJobLinksOnJobWrite` reverse fan-out; the trigger column set (a docstring contract line — keep it accurate).
- `CLAUDE.md` "Event-sourcing invariants" + "DO NOT" sections — the re-fold determinism contract, the schema-defaults-match-zero-event invariant, and the "never throw inside the fold transaction" rule.

**Optional**:
- `src/db.ts:572` — `addColumnIfMissing` helper definition.
- `src/db.ts:589` — `dropColumnIfPresent` (or equivalent helper docstring); verify the helper exists before relying on it.
- `src/db.ts:1820-1961` — v20→v21 in-place re-derive backfill (alternative pattern — NOT used here, useful as contrast).
- `test/db.test.ts:2965-3270` — v20→v21 migration test (template for the v23 → v24 test).

### Risks

- **Mixed-shape entries in `epics.jobs` / `epics.tasks[].jobs` arrays** if the migration is paired-ADD-only without the rewind. The fix is rigorous: use the v17→v18 step byte-for-byte as template (`addColumnIfMissing` + `last_event_id = 0` + three DELETEs).
- **`enrichJobLink` literal key order drift** between the live helper and any inline backfill SELECT in the migration. Mitigation: route the migration's enrichment through the same helper function rather than re-inlining the SELECT, or (if that's awkward across the open-DB boundary) write a second-layer test that compares live-emitted JSON to migration-emitted JSON byte-for-byte for the same `(jobs, epics)` seed state.
- **`dropColumnIfPresent` may or may not exist as a named helper** — repo-scout flagged this as `[INFERRED]`. If it doesn't, either add it (small helper, mirrors `addColumnIfMissing`) or use SQLite's native `ALTER TABLE … DROP COLUMN` (Bun's bundled SQLite supports it). Either way, the drop must be idempotent (re-running the migration after a partial failure must be safe).
- **Test fixture lockstep blast radius** — 35+ `rate_limited_at: null` occurrences across the test tree. Missing any leaves a compile error (TypeScript catches the field rename, but `as` cast literals would silently mis-shape). Use `grep -rn 'rate_limited_at' test/` as the completeness gate before committing.
- **Synthetic event `ApiError` arm present but no producer yet** — task .2 adds the producer (transcript matcher + daemon mint). Until then, the `case "ApiError"` arm is dead code. This is fine and intentional — the schema can land independent of the matcher, which is exactly the point of the strict dep chain.

### Test notes

- The v23 → v24 migration test mirrors `test/db.test.ts:2965-3270`. Seed a v23 DB with jobs+epics rows carrying the old shape (including a non-null `rate_limited_at` to confirm the rewind-and-redrain correctly drops the projection — the new value comes from re-folding the original `RateLimited` events).
- The dual-case alias coverage gate: a `RateLimited` event minted with the legacy shape and an `ApiError` event minted with `data.kind = "rate_limit"` must produce byte-identical `jobs` rows and `epics.job_links[]` entries when folded into otherwise-identical seed states.
- Negative coverage: a `RateLimited` fold on an `ENDED`/`KILLED` row must NOT resurrect the row (today's behavior preserved); both new columns stay NULL.

## Acceptance

- [ ] `src/types.ts`: `Job`, `EmbeddedJob`, `JobLinkEntry` widen to `(last_api_error_at, last_api_error_kind)`. `rate_limited_at` field gone from all three. `ApiErrorKind` literal union exported.
- [ ] `src/reducer.ts`: `EmbeddedJobElement`, `JobsRowForSync` widen. `buildEmbeddedJob` fills both fields. `enrichJobLink` SELECT + helper widen; missing-row default literal explicitly emits both new fields as JSON null. `syncJobLinksOnJobWrite` trigger column set updated; docstring at `:1744` accurate.
- [ ] `src/reducer.ts:2388-2419`: dual-case fold arm (`case "RateLimited":` + `case "ApiError":`) routing to one handler. Compound UPDATE writes both new columns. Terminal-row guard preserved. `syncIfPlanRef` conditional call preserved.
- [ ] `src/reducer.ts:2277-2289`: `UserPromptSubmit` revival clears BOTH new columns together. No code path writes one without the other.
- [ ] `src/db.ts`: `SCHEMA_VERSION` bumped to 24 at `:56`. v23 → v24 migration block added following the v17→v18 rewind-and-redrain template byte-for-byte. `CREATE_JOBS` literal at `:432` declares both new columns; `rate_limited_at` removed from the literal. The migration is forward-only, idempotent on re-run, version-guarded.
- [ ] `src/collections.ts:90-105`: JOBS_DESCRIPTOR.columns swap — `"rate_limited_at"` removed; `"last_api_error_at"`, `"last_api_error_kind"` added.
- [ ] `src/readiness.ts:615` JSDoc updated (doc-only, no logic change).
- [ ] New v23 → v24 migration test in `test/db.test.ts` passes; sibling tests that pin the schema version updated to `"24"`.
- [ ] All 35+ `rate_limited_at: null` fixture defaults migrated to two-field defaults; full `grep -rn 'rate_limited_at' src/ test/` returns zero matches (except the migration block's `dropColumnIfPresent` call, which is the one legitimate residual reference).
- [ ] Dual-case alias coverage test passes: a `RateLimited` event and an `ApiError(kind="rate_limit")` event fold to byte-identical projection rows.
- [ ] `bun test` passes; existing rate-limit tests pass under the renamed columns (this is the keystone — the historical event log re-folds deterministically).

## Done summary
Widened jobs.rate_limited_at into the two-field (last_api_error_at, last_api_error_kind) pair across types/reducer/collections, landed v23→v24 rewind-and-redrain migration, and converted the RateLimited fold into a dual-case alias over RateLimited|ApiError so the historical event log re-folds byte-deterministically with kind='rate_limit'. Added dual-case alias coverage + canonical kind round-trip + unknown-fallback + terminal-row guard reducer tests; added a v23→v24 migration test that pins the rewind-then-redrain rebuilds projections via the dual-case alias. board.ts call sites read the new field name (preserves the [limited] pill text until task .3 widens it into [failed:<kind>]).
## Evidence
