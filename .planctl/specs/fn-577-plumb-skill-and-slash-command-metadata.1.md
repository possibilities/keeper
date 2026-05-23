## Description

**Size:** M
**Files:**
- `src/db.ts` (migration block, `CREATE_EVENTS` + `CREATE_JOBS`
  literal updates, `SCHEMA_VERSION` bump, `stmts.insertEvent` SQL)
- `plugin/hooks/events-writer.ts` (two new pure parsers wired into
  the per-row composition + INSERT call site)
- `src/reducer.ts` (SessionStart fold derives `plan_verb`/`plan_ref`;
  `drain()` SELECT extended)
- `src/daemon.ts` (two synthetic `insertEvent` call sites get
  trailing `null` args)
- `src/types.ts` (`Event` + `Job` shapes extended)
- `src/collections.ts` (`JOBS_DESCRIPTOR.columns` extended)
- `test/events-writer.test.ts` (parser unit + hook integration)
- `test/db.test.ts` (v8→v9 migration test; bump `"8"` → `"9"`
  literals at lines ~172, 277, 318, 371, 400)
- `test/reducer.test.ts` (SessionStart derivation + RESUME
  idempotency + re-fold idempotency; extend the `insertEvent` test
  helper SQL for the two new event columns)
- `README.md` (Architecture column inventory; Inspect example
  queries)

### Approach

Mirror the v3→v4 spawn_name + title_source precedent. Four pieces,
all landing in one PR / one `SCHEMA_VERSION` bump:

1. **Schema migration (`src/db.ts:422-429` ALTER slot, bump
   `SCHEMA_VERSION` 8 → 9):**
   - Add four columns via `addColumnIfMissing`:
     `events.slash_command TEXT`, `events.skill_name TEXT`,
     `jobs.plan_verb TEXT`, `jobs.plan_ref TEXT`.
   - Update `CREATE_EVENTS` and `CREATE_JOBS` literals
     (`db.ts:206-253`) in lockstep so fresh DB === migrated DB.
   - Three partial indexes: `idx_events_slash_command`,
     `idx_events_skill_name` on `events`, and `idx_jobs_plan_ref`
     on `jobs`. All `WHERE col IS NOT NULL`. Skip a `plan_verb`
     index (cardinality 3 — `plan_ref`'s partial index covers the
     common "find /plan: jobs" query, and `plan_verb` filters are
     best evaluated post-index-seek).
   - **Same-transaction JS-driven backfill** inside the
     `BEGIN IMMEDIATE` block: iterate existing events, apply the
     pure parsers, write columns back; iterate existing jobs, look
     up the SessionStart event's `spawn_name`, apply the spawn
     parser, write `plan_verb`/`plan_ref` back. JS rather than SQL
     because the slash-command anchored regex isn't expressible in
     SQLite without REGEXP. Reuse the same parsers the hook +
     reducer use — one source of truth, no duplication.

2. **Three pure parsers** (one source of truth — pick a small
   module like `src/derivers.ts` so the hook, reducer, AND
   `migrate()` can all import them without circular deps):
   - `slashCommandFromPrompt(prompt: string): string | null` —
     regex `/^\/[a-z][\w:-]*/` (strict start-of-string; lowercase
     required after `/` so file paths like `/Users/...` never
     false-match; allows `[\w:-]` thereafter; stops at first
     non-matching char). Module-scope `const` so V8/JSC tier-up
     fires.
   - `extractSkillName(hookEvent, toolName, data): string | null` —
     gated `(hookEvent === 'PreToolUse' || hookEvent ===
     'PostToolUse') && toolName === 'Skill'`. Reads
     `data.tool_input.skill` via the existing `strField` defensive
     pattern; tolerates non-object/non-string, returns null. Shape
     mirrors `extractSubagentAgentId` exactly.
   - `planVerbRefFromSpawnName(spawnName: string | null):
     { plan_verb: string | null; plan_ref: string | null }` —
     regex `/^(plan|work|close)::(fn-\d+-[a-z0-9-]+(?:\.\d+)?)$/`.
     Strict whitelist (no `audit`). Refuses extra `::` segments
     (the `$` anchor handles this). Returns both null on any
     mismatch.

3. **Hook plumbing (`plugin/hooks/events-writer.ts:174-222`):**
   - Compute `slashCommand` (only when `hookEvent ===
     'UserPromptSubmit'`) and `skillName` after the existing
     `subagentAgentId` line.
   - Extend `stmts.insertEvent.run(...)` with two new trailing args.
   - Update `stmts.insertEvent` SQL at `db.ts:533-539` — column
     list + `?` arity stay aligned.

4. **Three INSERT call sites sync** — the new column-list +
   arg-arity must match in all three:
   - `plugin/hooks/events-writer.ts:206-222` (real hook payload).
   - `src/daemon.ts:232-248` (synthetic `TranscriptTitle`) —
     append `null, null`.
   - `src/daemon.ts:334-350` (synthetic plan-snapshot) — append
     `null, null`.

5. **Reducer SessionStart fold (`src/reducer.ts:478-498`):**
   - In the SessionStart upsert, call
     `planVerbRefFromSpawnName(event.spawn_name)`, pass both values
     into the INSERT.
   - ON CONFLICT RESUME branch (`reducer.ts:481-485` equivalent)
     leaves both columns untouched — set-once identity, mirroring
     the existing `title`/`title_source` precedent.
   - Extend `Event` shape (`src/types.ts:19-42`) with the two new
     event columns; extend `drain()`'s SELECT
     (`reducer.ts:648-658`) so the reducer reads them. Extend
     `Job` shape (`src/types.ts:65-76`) with the two new job
     columns.

6. **Read surface (`src/collections.ts:79-90`):**
   - Append `plan_verb` and `plan_ref` to `JOBS_DESCRIPTOR.columns`.
   - Leave them OUT of `sortable` / `filters` (mirror
     `title`/`title_source`/`transcript_path` served-only
     precedent). Add to filters only if a real client query needs
     it later.
   - If an events descriptor exists in the collections registry,
     extend it the same way — `slash_command`/`skill_name` to
     `columns`. (Check during implementation; may be a no-op if
     events isn't a registered collection today.)

7. **README revisions:**
   - Architecture section (lines 232-293): add `plan_verb` /
     `plan_ref` to the inline jobs column inventory; note they're
     derived at SessionStart from `spawn_name`.
   - Inspect section (lines 296-315): extend or replace the
     example `SELECT` on jobs with one demonstrating the new
     indexed lookup; add a one-liner for `events.skill_name`.
     Revise existing prose, don't append a new block.

### Investigation targets

**Required** (read before coding):
- `src/db.ts:206-253` — `CREATE_EVENTS` + `CREATE_JOBS` literals
  (keep in lockstep with `addColumnIfMissing`).
- `src/db.ts:339-374` — `addColumnIfMissing` helper (use this; do
  not write raw ALTER).
- `src/db.ts:422-429` — v3→v4 ALTER block (the precedent + the
  slot to append to).
- `src/db.ts:521` — `migrate()` `BEGIN IMMEDIATE` wrapper.
- `src/db.ts:533-539` — `stmts.insertEvent` SQL (extend column
  list + `?` arity).
- `plugin/hooks/events-writer.ts:82-117` — `extractSubagentAgentId`
  + `nameFromArgs` (parser shape precedent — pure, exported,
  regex-based, returns `string | null`).
- `plugin/hooks/events-writer.ts:174-222` — composition + INSERT
  call site.
- `src/reducer.ts:478-498` — SessionStart upsert + ON CONFLICT
  RESUME branch.
- `src/reducer.ts:648-658` — `drain()` SELECT column list.
- `src/daemon.ts:232-248`, `src/daemon.ts:334-350` — synthetic
  INSERT call sites.
- `src/collections.ts:76-115` — `JOBS_DESCRIPTOR` (single source
  of truth for served jobs columns).
- `src/types.ts:19-42` (`Event`), `src/types.ts:65-76` (`Job`).
- `test/events-writer.test.ts:66-121` — `fireViaLauncher` +
  `nameFromArgs` test patterns (mirror these for the two new
  parsers).
- `test/db.test.ts:225-320` — v3→v4 migration test (template for
  v8→v9; build a v8-shape DB by hand with stamped `"8"`, seed
  historical rows, open via `openDb`, assert columns + backfill +
  re-`openDb` no-op + new stamp).
- `test/reducer.test.ts:49-98` — `insertEvent({hook_event,
  ...overrides})` helper (extend its raw INSERT SQL for the two
  new event columns).
- `test/reducer.test.ts:449-579` — title-precedence tests
  (precedent for `plan_verb`/`plan_ref` derivation tests).
- `test/reducer.test.ts:512-527` — re-fold idempotency template.

**Optional**:
- `src/server-worker.ts` — verify it routes through
  `descriptor.columns` (repo-scout confirmed; one-touch check).

### Risks

- **Hook payload field name drift** — `data.prompt` and
  `data.tool_input.skill` are NEW fields for keeper to consume.
  Verified empirically during planning against the live event log;
  if Claude Code renames either, derivation silently goes to NULL
  with no error. Acceptable today. If `slash_command` / `skill_name`
  are unexpectedly NULL after deploy, the wire format is the first
  place to look.
- **Backfill aborts mid-transaction** — `BEGIN IMMEDIATE` rolls
  back ALTERs and backfill together. Add an integration test that
  injects a malformed event row mid-backfill and asserts the
  migration either converges cleanly or rolls back fully (no
  half-state).
- **Bun statement cache invalidation (oven-sh/bun#1332, open as
  of 2025-11-25)** — `migrate()` runs before workers spawn and
  before main caches `stmts.insertEvent`, so we're safe by
  ordering. Don't introduce a new pre-`migrate()` `db.query(...)`
  on `events` or `jobs` that would pin pre-ALTER metadata.
- **Three INSERT call sites drift** — easy to forget the daemon
  synthetic paths. Integration test should hit all three (hook,
  transcript synthetic, plan synthetic) and SELECT-back to assert
  column shape, not just the hook.

### Test notes

- **Unit tests** for all three parsers (`slashCommandFromPrompt`,
  `extractSkillName`, `planVerbRefFromSpawnName`) in
  `test/events-writer.test.ts` or a sibling test file: exhaustive
  cases including boundary anchoring (`/Users/...` rejects on
  uppercase), NULL/empty/non-string inputs, multi-token strings,
  extra `::` rejection in spawn-name parser, `audit::fn-…`
  returning `(null, null)` (whitelist excludes audit).
- **Hook integration** via `fireViaLauncher` (mirror
  `test/events-writer.test.ts:66-82`): real `UserPromptSubmit`
  payload → `slash_command` populated, `skill_name` NULL; real
  Skill `PreToolUse` payload → `skill_name` populated,
  `slash_command` NULL; SessionStart with `close::fn-575-...` →
  event row insertable + jobs row eventually carries
  `plan_verb='close'`, `plan_ref='fn-575-...'`.
- **Migration test** mirroring `test/db.test.ts:225-320`: build
  a v8-shape DB by hand with stamped `schema_version='8'`; seed
  historical events with sample prompts (`/plan:work fn-X.Y`,
  free text, file paths like `/Users/...`) and Skill PreToolUse
  with `tool_input.skill='plan:plan'`; seed historical jobs with
  sample `spawn_name`s (matching, non-matching, NULL); call
  `openDb` (triggers migrate); assert (a) all 4 columns added
  with `notnull=0`, (b) 3 partial indexes present, (c) backfill
  populated correctly per parser semantics, (d) second `openDb`
  is no-op, (e) stamped `schema_version='9'`.
- **Reducer derivation tests** mirroring `reducer.test.ts:449-579`:
  SessionStart with `spawn_name='close::fn-575-osc-parser-...'` →
  jobs row with `plan_verb='close'`, `plan_ref='fn-575-osc-parser-
  ...'`. SessionStart with `spawn_name='audit::fn-1-foo'` → both
  NULL (audit not in whitelist). SessionStart with `spawn_name`
  NULL → both NULL. Malformed `verb::ref::extra` → both NULL.
- **RESUME idempotency**: two SessionStarts with different
  spawn_names → second is no-op for `plan_verb`/`plan_ref`
  (set-once, mirror title precedent).
- **Re-fold idempotency** (extend
  `test/reducer.test.ts:512-527`): drain → reset cursor + `DELETE
  FROM jobs` → drain again → byte-identical jobs rows including
  the new columns.
- **`schema_version` literal bumps**: update the `"8"` expectations
  at `test/db.test.ts:172, 277, 318, 371, 400` to `"9"`.
- **`insertEvent` test helper** at `test/reducer.test.ts:71-93`:
  extend the raw INSERT SQL + bound args for the two new event
  columns. Existing tests pass `null` for both.

## Acceptance

- [ ] `events.slash_command` and `events.skill_name` columns
  present (TEXT, nullable); `events`-partial indexes
  `WHERE col IS NOT NULL` present.
- [ ] `jobs.plan_verb` and `jobs.plan_ref` columns present (TEXT,
  nullable); `idx_jobs_plan_ref WHERE plan_ref IS NOT NULL`
  present.
- [ ] `addColumnIfMissing` used for all four; `CREATE_EVENTS` /
  `CREATE_JOBS` literals updated in lockstep so fresh DB and
  migrated DB converge to identical schema.
- [ ] `SCHEMA_VERSION` bumped 8 → 9; stamped on migrate.
- [ ] Hook writes `slash_command` correctly on
  `UserPromptSubmit` (regex `/^\/[a-z][\w:-]*/`, NULL on
  irrelevant events including non-string `data.prompt`).
- [ ] Hook writes `skill_name` correctly on Pre/PostToolUse +
  `tool_name='Skill'` (reads `data.tool_input.skill`, NULL on
  other tools or events).
- [ ] Reducer derives `plan_verb`/`plan_ref` from `spawn_name` on
  SessionStart using the strict `{plan,work,close}` whitelist;
  both NULL on `audit::`, `develop::`, NULL spawn, or malformed
  shape.
- [ ] ON CONFLICT RESUME branch leaves both columns untouched on
  duplicate SessionStart (set-once identity).
- [ ] Same-transaction backfill populates existing event and job
  rows; `EXPLAIN QUERY PLAN` on a `WHERE plan_verb='close'`
  SELECT shows `SEARCH ... USING INDEX idx_jobs_plan_ref`
  (or equivalent index hit).
- [ ] All three `stmts.insertEvent` call sites updated (hook +
  two synthetic); `drain()` SELECT extended; `insertEvent` test
  helper extended.
- [ ] `JOBS_DESCRIPTOR.columns` includes `plan_verb` and
  `plan_ref`; existing subscribers see the new fields.
- [ ] `Event` and `Job` type shapes extended in lockstep with
  the SQL schema; TypeScript checks pass.
- [ ] Test coverage: parser unit tests (all three), hook
  integration tests (slash + skill + spawn paths), migration test
  (v8→v9 with backfill + idempotency), reducer derivation +
  RESUME idempotency + re-fold idempotency.
- [ ] README Architecture column inventory and Inspect example
  queries updated; revises existing prose, doesn't append.
- [ ] Hook still exits 0 on parser throw / DB failure / any
  thrown exception (existing `import.meta.main` envelope
  unchanged).
- [ ] No new third-party deps in the hook import graph.

## Done summary
Schema v10 lands events.slash_command + events.skill_name + jobs.plan_verb + jobs.plan_ref with three partial indexes, same-transaction backfill via three pure derivers in src/derivers.ts (shared by hook + reducer + migration), and full parser/migration/reducer test coverage.
## Evidence
