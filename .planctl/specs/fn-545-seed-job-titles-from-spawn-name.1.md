## Description

**Size:** M
**Files:** src/db.ts, plugin/hooks/events-writer.ts, src/reducer.ts, src/collections.ts, src/types.ts, CLAUDE.md, README.md, test/db.test.ts, test/reducer.test.ts, test/events-writer.test.ts

### Approach

Make `jobs.title` correct as early as SessionStart by seeding it from the session's spawn name (the `--name`/`-n` flag on the parent claude process argv), and introduce a title-provenance/precedence model so a later transcript-reading epic slots in as a higher-priority writer with no reducer rewrite. Tier 0 (folding payload `session_title` from `UserPromptSubmit`) already exists; this closes the `[SessionStart, first UserPromptSubmit)` window where the row currently reads `title=NULL`. Four coupled seams land together: schema, hook capture, reducer precedence, read surface + docs.

**Schema (src/db.ts).** Add `spawn_name TEXT` as the last column of `CREATE_EVENTS` (after `subagent_agent_id`, db.ts:84) and `title_source TEXT` as the last column of `CREATE_JOBS` (after `title`, db.ts:101-112). Both nullable, no default (NULL `title_source` = priority 0 = the zero-event reading; no backfill needed). Bump `SCHEMA_VERSION` 3→4 (db.ts:27). In `migrate()` (the ALTER slot at db.ts:250-260, before the `meta` version-stamp), add two idempotent steps: `addColumnIfMissing(db, "events", "spawn_name", "TEXT")` and `addColumnIfMissing(db, "jobs", "title_source", "TEXT")`, with a `// v3→v4:` comment matching the existing block style. Add `spawn_name` to BOTH events SELECT/INSERT sites: the prepared `insertEvent` column list + placeholder (db.ts:276-282, becomes the 15th column/bind) AND `selectEventsAfter` (db.ts:283-291). **GOTCHA: there is a THIRD events-SELECT — the inline `drain()` query in src/reducer.ts:211-218 — add `spawn_name` there too or the reducer never sees the column.**

**Hook capture (plugin/hooks/events-writer.ts).** Factor a pure exported `nameFromArgs(args: string): string | null` helper (so it is unit-testable). Parse a single whitespace-delimited token after `--name=`, `--name `, or `-n ` — anchored to a flag boundary (`(?:^|\s)`) so `--rename`/`--username` can't false-match. **Single-token policy is intentional** (locked decision): macOS `ps -o args=` space-joins argv and drops shell quoting, so a multi-word `--name "a b"` is indistinguishable from trailing args; capture only the first token (session names are compound-word single tokens by convention, so this never bites). Add a `spawnNameFromPpid(): string | null` helper that runs `Bun.spawnSync(["ps","-ww","-p",String(process.ppid),"-o","args="], { timeout: 500 })`, checks `result.success`/`exitCode === 0`, reads `result.stdout?.toString() ?? ""`, trims, and passes to `nameFromArgs` — the ENTIRE body wrapped in try/catch returning null (`Bun.spawnSync` THROWS ENOENT if `ps` is missing, so a bare success check is insufficient). Call it ONLY when `hookEvent === "SessionStart"` (mirror the `subagent_agent_id` gating at events-writer.ts:82-98); a `ps` fork on every hook would blow the cold-start/timeout budget. Bind the result as the new 15th positional arg in the `insertEvent.run(...)` call (events-writer.ts:150-167), matching the INSERT column order. `Bun.spawnSync` is a Bun global — NO new import (import-graph constraint holds). Single-level `process.ppid` is correct here (the probe validated this scrape across 23 real sessions under the arthack-claude.py launcher; PPID-walking is explicitly deferred robustness, not this task).

**Reducer precedence (src/reducer.ts).** Two changes in `projectJobsRow`:
1. The SessionStart `INSERT OR IGNORE` (reducer.ts:100-103) extends its 6-column list to seed `title = event.spawn_name` and `title_source = (event.spawn_name ? 'spawn' : NULL)`. (On a duplicate SessionStart the OR IGNORE no-ops — intended; the seed only lands on first insert.)
2. Generalize the existing title rule (reducer.ts:148-159) into a precedence write. Define a code-side priority map `{ spawn: 1, payload: 2 }` (transcript epic later adds `3`). `extractSessionTitle` (reducer.ts:64-81) supplies the `payload` source (priority 2). For an incoming `(title, source, p)`, `SELECT title, title_source FROM jobs WHERE job_id = ?` (note: currently selects only `title` — must also read `title_source`), compute persisted priority `pp` (NULL `title_source` → 0), and write iff `p > pp OR (p === pp AND persistedTitle !== title)`, setting BOTH `title` and `title_source` and bumping `last_event_id`/`updated_at` in the same fold. **Re-fold determinism: compare against PERSISTED state read in-txn, never an accumulator** — pure function of persisted state, so a rebuild-from-scratch is identical. All inside the existing `BEGIN IMMEDIATE` in `applyEvent` (reducer.ts:173-187) — no nested transaction.

**Read surface (src/collections.ts) + types (src/types.ts).** Append `"title_source"` to `JOBS_DESCRIPTOR.columns` (collections.ts, alongside `"title"` at ~:80) so it is served on `result`/`patch` for debugging; leave it OUT of `sortable`/`filters` (read-only display, like `title`) and out of `jsonColumns`. No other SQL edit (selectByIds/countAndToken interpolate from the descriptor). Add `spawn_name: string | null` to `Event` (types.ts:34, after `subagent_agent_id`) and `title_source: string | null` to `Job` (types.ts:54, after `title`); update the `Job` JSDoc that says "last-write-wins" to describe precedence-ordered provenance.

**Docs.** See the epic's `## Docs gaps` for the full list — CLAUDE.md DO-NOT fence narrowing (the load-bearing one), state-machine bullets, the zero-event-defaults invariant, schema-v4 note, directory-layout entries; README.md non-goal bullet + jobs enumeration. AGENTS.md is a symlink to CLAUDE.md — editing CLAUDE.md is sufficient.

### Investigation targets

**Required** (read before coding):
- src/db.ts:27 — `SCHEMA_VERSION = 3` (bump to 4).
- src/db.ts:68-86 — `CREATE_EVENTS` (`subagent_agent_id TEXT` is the last column at :84; append `spawn_name`).
- src/db.ts:101-112 — `CREATE_JOBS` (`title TEXT` last; append `title_source`).
- src/db.ts:184-197 — `addColumnIfMissing` (idempotent ALTER helper); :250-260 — the migrate() ALTER slot + `meta` stamp.
- src/db.ts:276-291 — prepared `insertEvent` (14 binds → 15) AND `selectEventsAfter` (both need `spawn_name`).
- plugin/hooks/events-writer.ts:82-98 — `extractSubagentAgentId` (the gating + try-shape precedent for `spawnNameFromPpid`); :141,:150-167 — where it's extracted and bound as the last positional arg; :127 — `process.ppid` already used; :177-182 — the exit-0 outer guard.
- src/reducer.ts:64-81 — `extractSessionTitle` (payload source); :100-103 — SessionStart INSERT OR IGNORE (6 cols); :148-159 — the existing title rule to generalize; :173-187 — `applyEvent` BEGIN IMMEDIATE; :211-218 — the inline `drain()` SELECT (third site needing `spawn_name`).
- src/collections.ts:69-97 — `JOBS_DESCRIPTOR` (`columns` ~:80 is the SOLE place to add `title_source`).
- src/types.ts:19-35 — `Event`; :46-55 — `Job`.
- CLAUDE.md:183-185 — the DO-NOT "name scraping" fence to narrow; :107-114 — state-machine title bullets; :132 — zero-event-defaults invariant; :120-122 — schema-v3 retirement note.

**Optional** (reference as needed):
- test/db.test.ts:194-236 — "v2→v3 migrates" test (copy exactly for a v3→v4 test); :160-167 — asserts `schema_version == "3"` (bump to "4").
- test/reducer.test.ts:49-96 — `insertEvent(overrides)` helper (its INSERT col list + row defaults need `spawn_name`); :266-364 — title-fold test cluster + `titleEvent` helper.
- test/integration.test.ts:117-123 — `fireHook` (throws on non-zero exit; the exit-0 enforcement seam).
- ~/.local/bin/arthack-claude.py:~2524 — confirms the launcher injects `--name <session_name>` into the claude argv (the source format `nameFromArgs` parses).

### Risks

- **Three events-INSERT sites + three events-SELECT sites must stay in sync** — prepared `insertEvent` (db.ts), the hook's `.run()` binds (events-writer.ts), the test `insertEvent` helper (reducer.test.ts); and `selectEventsAfter` (db.ts) + the inline `drain()` SELECT (reducer.ts). Miss one and `spawn_name` is silently NULL at the reducer or a bind-count mismatch throws. Grep `subagent_agent_id` to enumerate every site — `spawn_name` mirrors it everywhere.
- **Exit-0 contract** — all `ps`/parse logic must live inside a helper that returns null on ANY failure (incl. `Bun.spawnSync` ENOENT throw), called from within `main`. Nothing may throw synchronously outside `main`'s promise chain.
- **Re-fold determinism** — the precedence write must read persisted `(title, title_source)` in-txn and be a pure function of it; an accumulator or wrong `pp`-default (NULL must map to 0) breaks rebuild-from-scratch idempotency.
- **Precedence monotonicity** — a lower-priority source must NEVER overwrite a higher one (spawn=1 can't clobber a payload=2 title). The `p > pp OR (p == pp AND changed)` rule encodes this; test it directly.

### Test notes

- `nameFromArgs` unit (new test/events-writer.test.ts — export the helper): `--name=foo`, `--name foo`, `-n foo` all → `"foo"`; multi-word `--name foo bar` → `"foo"` (single-token); `--rename foo`/`--username foo` → null; absent → null; empty string → null.
- DB: `schema_version` now `"4"`; a populated v3 DB migrates and existing rows gain `spawn_name=NULL`/`title_source=NULL` with data preserved (copy test/db.test.ts:194-236).
- Reducer: SessionStart with `spawn_name` seeds `title=spawn_name`, `title_source='spawn'`; SessionStart with NULL `spawn_name` → `title=NULL` (Tier 0 still folds at first UPS). A subsequent UPS whose payload title == spawn name bumps `title_source` to `'payload'` (priority rose, value unchanged) per the `p > pp` rule; a differing payload title updates value + source; a `'spawn'`-priority write never overwrites a `'payload'` title. Re-fold/rebuild-from-scratch yields identical `(title, title_source)`. Tier 0 alone (no spawn_name) still folds the payload title unchanged.
- Hook (integration): SessionStart populates `spawn_name` (when a `--name` is on the parent argv); a non-SessionStart event leaves `spawn_name` NULL; the hook exits 0 even if `ps` fails.

## Acceptance

- [ ] `events` has `spawn_name TEXT` (nullable) and `jobs` has `title_source TEXT` (nullable); `SCHEMA_VERSION` is 4 and an already-v3 DB migrates cleanly via two idempotent `addColumnIfMissing` steps (existing rows read both columns NULL, data preserved).
- [ ] On `SessionStart` ONLY, the hook scrapes `--name`/`-n` from the parent process argv via `Bun.spawnSync(["ps",...])` and writes it to `events.spawn_name`; a pure exported `nameFromArgs` parses all flag forms (`--name=X`/`--name X`/`-n X`) single-token; the scrape never throws and the hook still always exits 0; non-SessionStart rows have `spawn_name = NULL`; NO new imports added.
- [ ] The reducer seeds `jobs.title`/`title_source='spawn'` from `spawn_name` on the SessionStart insert, and the generalized title rule writes by precedence (`{spawn:1, payload:2}`, write iff `p > pp OR (p == pp AND value changed)`), comparing PERSISTED `(title, title_source)` read in-txn; a lower-priority source never overwrites a higher one; the fold stays inside the one `BEGIN IMMEDIATE` and re-folds idempotently.
- [ ] `title_source` is served on `result`/`patch` frames via `JOBS_DESCRIPTOR.columns` (not in `sortable`/`filters`); `Event.spawn_name` and `Job.title_source` exist on the types.
- [ ] CLAUDE.md DO-NOT fence narrowed to allow spawn-name-at-SessionStart-in-hook-frozen-to-event ONLY (still forbidding multi-session lineage + general/ongoing name scraping); state-machine + zero-event-defaults + schema-v4 docs and README non-goal updated. Tier 0 (payload `session_title` fold) still works unchanged.
- [ ] `bun test --isolate` passes, including new `nameFromArgs` unit, db v3→v4 migration, reducer precedence (seed/promotion/monotonicity/re-fold), and hook spawn_name cases.

## Done summary
Seed jobs.title from the parent claude --name/-n spawn name at SessionStart (events.spawn_name, scraped via ps in the hook, SessionStart-only, exit-0-safe) and add a title-provenance precedence model (jobs.title_source: NULL=0, spawn=1, payload=2; write iff incoming priority outranks or ties+changes, comparing persisted state in-txn). Schema v3->v4 adds both nullable columns idempotently. title_source served on the jobs read surface; docs (CLAUDE.md DO-NOT fence narrowed, README) updated.
## Evidence
