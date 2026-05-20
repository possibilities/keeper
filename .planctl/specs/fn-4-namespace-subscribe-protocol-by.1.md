## Description

**Size:** M
**Files:** src/collections.ts (new), src/protocol.ts, src/server-worker.ts, src/db.ts, test/protocol.test.ts, test/server-worker.test.ts, test/db.test.ts, test/integration.test.ts, CLAUDE.md, README.md

Namespace the read surface by a `collection` field so `jobs` becomes the first of N collections. Everything collection-specific that's currently hardcoded for jobs moves into a `CollectionDescriptor`; `runQuery` and `diffTick` route through `getCollection(name)` instead of hardcoding `FROM jobs` / `job_id` / `last_event_id`. The whole change is one type-interdependent unit — `protocol.ts` type edits break `server-worker.ts` and the tests until all land together, so there is no parallel-safe sub-seam.

### Approach

1. **New `src/collections.ts`** (house-style header comment + cross-refs to `db.ts`/`protocol.ts`/`server-worker.ts`):
   - `export type Row = Record<string, unknown>` — the generic served-row shape.
   - `CollectionDescriptor`: `name`, `table`, `columns: readonly string[]`, `pk: string`, `version: string` (monotonic per-row column the diff fires on), `sortable: ReadonlySet<string>`, `defaultSort: { column; dir }`, `filters: Readonly<Record<string,string>>` (filter-key → SQL column).
   - `REGISTRY = Map<string, CollectionDescriptor>` with one entry, `getCollection(name)`.
   - The jobs descriptor: table `jobs`; columns = the current SELECT list (`job_id,created_at,cwd,pid,mode,state,last_event_id,updated_at`); `pk: "job_id"`; `version: "last_event_id"`; `sortable` = the current `SORTABLE_COLUMNS` set; `defaultSort: { column:"updated_at", dir:"desc" }`; **`filters` MUST include the pk** → `{ state:"state", mode:"mode", cwd:"cwd", job_id:"job_id" }` (detail-page single-item subscribe).
   - `selectByIds(db, descriptor, ids)` — generalize `db.ts`'s `selectJobsByIds`: preserve the empty-set → `[]` short-circuit (bare `IN ()` is a SQL syntax error), the `MAX_IN_PARAMS` cap throw (import the existing export from `db.ts:64`, do not redefine), per-call prepare. Interpolate `descriptor.table`/`columns`/`pk` (trusted constants); bind the ids. Return rows the caller can re-index by `descriptor.pk` (SQLite emission order, not input order — keep that contract).
2. **`src/db.ts`**: keep `selectJobsByIds` as a thin typed wrapper over `selectByIds(db, JOBS_DESCRIPTOR, ids)` if anything else still imports it, OR delete it and migrate the sole importer; either way `MAX_IN_PARAMS` stays exported from `db.ts`.
3. **`src/protocol.ts`**: drop `import { Job }` and the `QueryFilter` interface. `QueryFrame` gains required `collection: string`; `filter` retyped to `Record<string,string|number>`. `ResultFrame<R extends Row = Row>` and `PatchFrame<R extends Row = Row>` go generic, both gain `collection: string`; rename `PatchFrame.job` → `row`. `ErrorFrame` gains optional `collection?: string` (spread conditionally, mirroring the `...(id !== undefined ? {id} : {})` idiom) and the new `unknown_collection` code is documented. The framing layer (`encodeFrame`/`extractLines`/`LineBuffer`/`OversizedLineError`/`MAX_LINE_BYTES`) is untouched. Add a short doc note that membership is frozen at query time (cells stream; rows never enter/leave a live page) and that unknown frame fields are ignored for forward-compat.
4. **`src/server-worker.ts`**:
   - Delete the module-level `SORTABLE_COLUMNS` (now lives on the descriptor); update the `./db` import to `selectByIds`.
   - `ConnState`: keep the single `watched: Set<string>` + `lastSent: Map<string,number>`; add `collection: string | null` (init `null` in `newConnState`).
   - `runQuery`: look up `getCollection(frame.collection)`; on miss return an `unknown_collection` ErrorFrame (carry `collection` + `id`). Build SELECT from `descriptor.table`/`columns`; validate sort against `descriptor.sortable` (fallback `descriptor.defaultSort` — preserve "explicit `updated_at` with no dir → desc" by defaulting dir to `descriptor.defaultSort.dir` only when the chosen column equals the default column, else `asc`). Build WHERE by **map lookup**: for each `[key, col]` in `descriptor.filters`, if `frame.filter?.[key] != null` push `${col} = ?` + bind value. Never interpolate a wire filter key. Tiebreak `ORDER BY <sortCol> <dir>, <pk> ASC`.
   - `dispatchLine` query case: call `runQuery`; only when it returns a `result` (not an error), set `conn.collection`, and seed `watched`/`lastSent` from `result.rows` keyed by `descriptor.pk` / `descriptor.version`. A `bad_frame` (absent/empty/non-string `collection`) or `unknown_collection` error leaves the existing subscription **intact** (no mutation of `conn.collection`/`watched`/`lastSent`). `unsubscribe` resets `collection` to `null` alongside clearing `watched`/`lastSent`.
   - `diffTick`: group connections by `conn.collection` (skip `null`-collection conns); per collection group compute the union of watched ids and do ONE `selectByIds(db, descriptor, union)`; index by `descriptor.pk`; per connection emit `patch { type:"patch", collection, rev, row }` when `row[descriptor.version] !== null && > (lastSent ?? -1)`, then bump `lastSent`. Preserve the backpressure-skip (a `pending` conn is skipped without advancing `lastSent`). `rev` stays the global `readWorldRev` (reducer_state.last_event_id) — do NOT conflate it with the descriptor's per-row version column.
5. **Error code decision (pin in code + tests):** absent / empty-string / non-string `collection` → `bad_frame`; a well-formed string naming no descriptor → `unknown_collection`.

### Investigation targets

**Required** (read before coding):
- src/protocol.ts:37,47-62,71-78,91-96,102-119 — `Job` import, `QuerySort`/`QueryFilter`, and the four frame interfaces to edit.
- src/server-worker.ts:95-102 — `SORTABLE_COLUMNS` to migrate into the jobs descriptor.
- src/server-worker.ts:238-293 — `runQuery`: the hardcoded `FROM jobs`, column list, three filter branches, and the `updated_at`-defaults-to-desc logic to preserve.
- src/server-worker.ts:116-130 — `ConnState`/`newConnState` (add `collection`).
- src/server-worker.ts:314-362 — `dispatchLine` query/unsubscribe/default cases; seed at :335-344.
- src/server-worker.ts:490-565 — `unionWatched`/`diffTick`: the global union + `job.last_event_id`/`r.job_id` hardcodes to generalize and the backpressure skip at :541-546.
- src/db.ts:287-309 — `selectJobsByIds` to generalize; src/db.ts:64 — `MAX_IN_PARAMS` (reuse).
- test/integration.test.ts:308-402 — the canonical end-to-end wire-contract guard: sends `{type:"query",id:"q1"}` with NO collection and asserts `f.job.*`; must add `collection` and switch to `f.row.*`.

**Optional** (reference as needed):
- src/db.ts:269-272, src/server-worker.ts:380-385 — `readWorldRev` (stays collection-agnostic).
- src/wake-worker.ts — the autocommit/no-`BEGIN` `data_version` poll the realtime layer mirrors.
- test/server-worker.test.ts:53-77,84-97,393-433 — `seedJob`/`advanceJob`/`watch` helpers, `dispatchInit()` (hand-builds `ConnState` — MUST add `collection`), `fakeSock()`.
- test/protocol.test.ts:18,31-70 — `Job` import + round-trip tests broken by `.job`→`.row`, the `collection` echo, and the `filter` shape.
- test/db.test.ts:215-254 — `selectJobsByIds` coverage to migrate to `selectByIds`.

### Risks

- **Injection surface widens.** Every interpolated identifier (table, columns, pk, sort col) must come from the descriptor (trusted constants); wire `filter` *keys* are resolved via map lookup, never interpolated; `filter` *values* and limit/offset stay bound (`?`). Keep the existing injection test green (`"drop table jobs"` sort → fallback, no throw) and add one asserting a wire filter key that isn't in `descriptor.filters` is ignored, not interpolated.
- **`rev` vs per-row `version` must not collapse.** For jobs both read `last_event_id` today; the generalization must keep the frame `rev` = global reducer cursor and the diff comparison = `row[descriptor.version]`. Conflating them breaks any future collection whose version column ≠ the reducer cursor.
- **Subscription replacement atomicity.** The query case must replace `collection`+`watched`+`lastSent` in one synchronous block (no `await` splitting the seed) so no `diffTick` interleaves stale rows. Single-threaded JS makes this safe as long as the seed isn't awaited.
- **`dispatchLine` must still never throw** — an unknown collection routes to an error frame, not an exception.

### Test notes

- Update `dispatchInit()` to include `collection` or types break across the suite.
- Add coverage: query with valid `collection` → result echoes `collection`; absent/empty/non-string `collection` → `bad_frame`; well-formed unknown collection → `unknown_collection` AND prior subscription survives; detail-page single-item subscribe via `filter:{job_id}` → 1-row page that subsequently patches; unknown filter key ignored; `diffTick` groups by collection (a null-collection conn is never visited).
- `bun run typecheck`, `bun run lint`, and `bun test --isolate` must all pass.

## Acceptance

- [ ] `src/collections.ts` exists with `CollectionDescriptor`, `REGISTRY`, `getCollection`, the jobs descriptor (filters include `job_id`), `Row`, and `selectByIds` (empty-set→`[]`, `MAX_IN_PARAMS` throw preserved).
- [ ] `src/protocol.ts`: `QueryFrame.collection` required; `filter` is `Record<string,string|number>`; `QueryFilter` and the `Job` import removed; `ResultFrame`/`PatchFrame` generic over `Row` and echo `collection`; `patch.job` renamed to `patch.row`; `ErrorFrame` has optional `collection` + documented `unknown_collection` code.
- [ ] `runQuery` routes entirely through the descriptor (table/columns/pk/sortable/defaultSort/filters); unknown collection → `unknown_collection` error; jobs' "updated_at defaults to desc" behavior preserved; SQL identifiers only ever come from the descriptor.
- [ ] `ConnState` carries one `watched`/`lastSent` + `collection: string|null`; the query case seeds via descriptor pk/version and replaces atomically; a bad/unknown-collection query leaves the existing subscription intact; `unsubscribe` resets `collection` to null.
- [ ] `diffTick` groups connections by active collection, does one `selectByIds` per collection per tick, diffs on `descriptor.version`, emits `patch {collection, rev, row}`, and preserves the backpressure-skip; frame `rev` stays the global reducer cursor.
- [ ] Absent/empty/non-string `collection` → `bad_frame`; well-formed unknown string → `unknown_collection` (pinned by tests).
- [ ] All test suites updated (`selectJobsByIds`→`selectByIds`, `patch.job`→`patch.row`, `collection` added to queries, `dispatchInit` gains `collection`) plus the new cases above; `bun run typecheck` + `bun run lint` + `bun test --isolate` green.
- [ ] CLAUDE.md (directory layout: new `src/collections.ts` bullet, server-worker/protocol entries; module entry points table) and README.md (architecture + "what keeper is" wording) updated to describe the namespaced collection surface.

## Done summary

## Evidence
