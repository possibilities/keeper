## Description

**Size:** M
**Files:** src/db.ts, src/reducer.ts, src/collections.ts, src/server-worker.ts, src/types.ts, README.md, CLAUDE.md, test/db.test.ts, test/reducer.test.ts, test/server-worker.test.ts

### Approach

Add a `title` + `title_history` attribute to the `jobs` entity, folded from the `session_title` carried in the events `data` blob, and serve both over the UDS subscribe surface. Three coupled seams — write path, read path, docs — land together.

**Schema (src/db.ts).** Extend `CREATE_JOBS` (src/db.ts:99-110) with `title TEXT` (nullable, no default) and `title_history TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(title_history))`. Bump `SCHEMA_VERSION` 1→2 (src/db.ts:25). Fill the reserved migrate slot (src/db.ts:203-205) — change the guard to `if (current < 2)` and add the two `ALTER TABLE jobs ADD COLUMN ...` statements (identical column defs; `ADD COLUMN` does not rewrite existing rows, so prior `jobs` rows read `title=NULL, title_history='[]'`, matching the zero-event projection). Keep `CREATE_JOBS` and the ALTERs in sync.

**Reducer fold (src/reducer.ts).** Add `extractSessionTitle(event)` mirroring `extractPermissionMode` (src/reducer.ts:70-97): try/catch around `JSON.parse(event.data)`, skip-and-log via `console.error` on a malformed blob (cursor still advances), read the **top-level** `session_title`, return it only when `typeof === "string" && length > 0`, else `null`. (session_title is NOT an events column — the blob is the only carrier. Run event-agnostically like the mode rule, not gated to UserPromptSubmit; in practice only UserPromptSubmit carries it.) In `projectJobsRow`, after the lifecycle switch and the existing mode rule, add the title rule: when `extractSessionTitle` returns non-null, `SELECT title, title_history FROM jobs WHERE job_id = ?`; if a row exists **and** its `title` differs from the new title, JSON.parse `title_history`, push the new title (natural chronological order, **repeats allowed across reverts, NO dedup** — compare only against the current `title`, never "seen before"), and `UPDATE jobs SET title = ?, title_history = ?, last_event_id = ?, updated_at = ? WHERE job_id = ?`. When the title is unchanged, **skip the write entirely** (no `last_event_id` bump) — this is the re-fold-determinism rule (comparing against the persisted tail makes a rebuild-from-scratch produce identical history; unconditional append would double-count). No row → no-op. No `state != 'ended'` guard (mirror the mode rule — always lands; no title-bearing events arrive post-SessionEnd anyway). All of this runs inside the existing `BEGIN IMMEDIATE` in `applyEvent` (src/reducer.ts:178-192) — no nested transaction.

**Read-boundary decode (src/collections.ts + src/server-worker.ts).** Add `jsonColumns: ReadonlySet<string>` to `CollectionDescriptor` (src/collections.ts:46-55) and a `decodeRow(descriptor, row)` helper that, for each name in `descriptor.jsonColumns`, replaces the row's TEXT value with `JSON.parse`'d output — falling back to `[]` per-row on parse failure (honors "one bad row never wedges a reader"; NULL/empty also → `[]`). Apply `decodeRow` at BOTH row-producing reads so the query page and the diff/patch path agree on the array type: `selectByIds` (src/collections.ts:124-134, the diff path) and the page SELECT in `runQuery` (src/server-worker.ts:369-376). On `JOBS_DESCRIPTOR` (src/collections.ts:64-89), append `"title"` and `"title_history"` to `columns` and set `jsonColumns: new Set(["title_history"])`. Do NOT add `title` to `sortable`/`filters` (read-only display this phase). `countAndToken` (src/collections.ts:173-193) fingerprints pk only — leave it untouched (the `meta` signal is unaffected by title changes).

**Types (src/types.ts).** Add `title: string | null` and `title_history: string[]` to `Job` (src/types.ts:43-52) — `title_history` is the decoded shape at the read boundary.

**Docs.** README.md:10 (jobs projection enum — add `title`), README.md:174 (inspection SQL `SELECT job_id, state, mode, last_event_id FROM jobs` — add `title`). CLAUDE.md: state-machine `UserPromptSubmit` bullet (add a sentence on the title read-modify-write), the `src/collections.ts` descriptor field inventory (add `jsonColumns`), and the "defaults match the zero-event projection" invariant (name `title=NULL` / `title_history='[]'`).

### Investigation targets

**Required** (read before coding):
- src/db.ts:25,99-110,180-211 — `SCHEMA_VERSION`, `CREATE_JOBS`, `migrate()` + the reserved `if (current < 1)` ALTER slot.
- src/reducer.ts:70-97 — `extractPermissionMode` (mirror target for `extractSessionTitle`; the test asserts the exact `console.error` skip-and-log string).
- src/reducer.ts:108-165,178-192 — `projectJobsRow` (mode rule at 155-164 is the layering template) + `applyEvent` `BEGIN IMMEDIATE`.
- src/collections.ts:46-55,64-89,124-134,173-193 — `CollectionDescriptor`, `JOBS_DESCRIPTOR`, `selectByIds`, `countAndToken` (pk-only, leave alone).
- src/server-worker.ts:369-376 — the page SELECT in `runQuery` (second decode site).
- src/types.ts:43-52 — `Job` row shape.

**Optional** (reference as needed):
- src/server-worker.ts:736-741 — `diffTick` patch fires on `version > lastSent` (why bumping `last_event_id` only on real title change matters).
- plugin/hooks/events-writer.ts — confirms `session_title` is stored only in the raw `data` blob, never lifted to a column.
- test/reducer.test.ts (insertEvent `data` override + `getJob` reader; mode-from-blob test ~179-187; malformed-blob skip-and-log ~260-285), test/db.test.ts (schema_version asserts "1" ~159-166; selectByIds round-trip ~223-253), test/server-worker.test.ts (seedJob ~56-80; row assertions ~196-207).

### Risks

- **Decode parity** — if only one of the two reads decodes, `result` and `patch` serve `title_history` in different shapes (string vs array). One shared `decodeRow` called at both seams is the guard; assert both in tests.
- **Re-fold determinism** — the append MUST compare against the persisted `title` (read in-txn), not an accumulator, or a boot-drain rebuild produces a longer history. Cover with a re-fold/rebuild test.
- **Migration on populated DB** — existing `jobs` rows must upgrade cleanly (ADD COLUMN backfills `title_history='[]'`). Test v1→v2 on a seeded DB.

### Test notes

- Reducer: first title seeds `title="foo"`/`title_history=["foo"]`; A→B→A yields `["foo","bar","foo"]`; unchanged title fires no write (assert `last_event_id` unchanged by the title rule); malformed blob with a session_title still skip-and-logs and advances the cursor; title-bearing event for a non-existent job no-ops.
- Re-fold idempotency: draining the same event stream twice (or from scratch) yields identical `title_history`.
- DB: `schema_version` now `"2"`; a populated v1 DB migrates and existing rows read `title_history=[]`.
- Server/integration: `result` rows and a `patch` row both carry `title_history` as a real array (not a JSON string); a job seeded without a title decodes to `[]`.

## Acceptance

- [ ] `jobs` has `title TEXT` + `title_history TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(title_history))`; `SCHEMA_VERSION` is 2 and the migrate slot ALTERs an already-v1 DB cleanly.
- [ ] A `UserPromptSubmit` (or any event) carrying `session_title` folds into `jobs.title` and appends to `title_history` only when the title changed; unchanged titles produce no write; reverts append again (no dedup); the fold stays inside the one `BEGIN IMMEDIATE` and re-folds idempotently.
- [ ] A malformed `data` blob skips-and-logs and advances the cursor (reducer never wedges).
- [ ] `title` + `title_history` are served on `result` and `patch` frames, with `title_history` decoded to a real array at both read seams (page SELECT + selectByIds); a title-less job reads `[]`.
- [ ] `Job` type carries `title` / `title_history`; README + CLAUDE.md updated (projection enum, inspection SQL, state-machine bullet, descriptor field inventory, zero-event-defaults invariant).
- [ ] `bun test --isolate` passes, including new reducer (append/revert/unchanged/malformed/re-fold), db (schema_version=2, v1→v2 migration), and server round-trip (array shape) cases.

## Done summary

## Evidence
