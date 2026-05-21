## Description

**Size:** M
**Files:** src/db.ts, src/reducer.ts, src/types.ts, src/collections.ts, test/db.test.ts, test/reducer.test.ts

Land the fold (consume) side end-to-end so transcript titles can be proven
with hand-inserted synthetic events *before any watcher exists*. This is the
fn-545-shaped diff (mirror commit 5516c56) and is the epic's early proof point.

### Approach

1. **Schema v4→v5 (`src/db.ts`).** Add `transcript_path TEXT` to `CREATE_JOBS`
   (`:102-114`); add `addColumnIfMissing(db, "jobs", "transcript_path", "TEXT")`
   to the `migrate()` ALTER block (`:228-281`) following the v3→v4 step exactly;
   bump `SCHEMA_VERSION` to 5 (`:27`). No `events` column needed — the synthetic
   event carries its title in `data`, and the daemon reuses the existing
   `insertEvent` prepared stmt (no new stmt here).
2. **Reducer precedence (`src/reducer.ts`).** Add `transcript: 3` to
   `TITLE_PRIORITY` (`:69`). Generalize the hardcoded `const source = "payload"`
   (`:193`) into a small per-event resolver, e.g.
   `titleSourceForEvent(event) => event.hook_event === "TranscriptTitle" ? "transcript" : "payload"`.
   Reuse `extractSessionTitle` for both (the synthetic event carries
   `data.session_title`) — no second extractor. The precedence WRITE block
   (`:191-210`, `p > pp || (p === pp && row.title !== title)`) needs ZERO change.
3. **SessionStart seed (`src/reducer.ts:120-143`).** Seed `jobs.transcript_path`
   on the `INSERT OR IGNORE` by parsing `transcript_path` out of `event.data`
   (top-level field in the SessionStart payload, verified absolute) with a
   guarded parse mirroring `extractSessionTitle` (`:87-104`) — skip-and-log on a
   malformed blob, never throw. Add the column to the INSERT column list.
4. **Types + read surface.** `src/types.ts`: `Job.transcript_path: string | null`;
   extend the `title_source` doc comment with `'transcript' = 3`. `src/collections.ts`:
   add `transcript_path` to the `jobs` served `columns` (display/debug only — keep
   it OUT of `sortable` and `filters`, like `title`/`title_source`).

### Investigation targets

**Required** (read before coding):
- src/reducer.ts:69 — `TITLE_PRIORITY`; :87-104 `extractSessionTitle` (guarded-parse pattern); :120-143 SessionStart insert; :191-210 precedence write
- src/db.ts:27 `SCHEMA_VERSION`; :102-114 `CREATE_JOBS`; :186-199 `addColumnIfMissing`; :228-281 `migrate()` (v3→v4 step is the template)
- test/reducer.test.ts:373-451 — title-precedence + re-fold-determinism test template (rewind cursor, `DELETE FROM jobs`, re-drain, assert identical)
- test/db.test.ts:218-311 — the v3→v4 migration test to clone for v4→v5

**Optional** (reference as needed):
- src/types.ts:44-69 `Job`; src/collections.ts — `jobs` descriptor `columns`/`sortable`/`filters`
- git show 5516c56 — the fn-545 precedent diff (shape + test coverage)

### Risks

- The reducer's `default` branch (`:171-175`) already ignores unknown `hook_event`s, so a `TranscriptTitle` event triggers no lifecycle write — verify this holds (it does) so a synthetic event only flows through the title rule.
- Re-fold determinism is the crux: the title MUST come from the event log, never a direct `jobs` write. Test a rebuild-from-scratch with synthetic events interleaved.

### Test notes

- `test/db.test.ts`: clone the v3→v4 case for v4→v5 — hand-build the prior schema, insert rows, reopen via `openDb`, assert `transcript_path` exists + reads NULL on old rows + `SCHEMA_VERSION` stamped 5 + second open idempotent.
- `test/reducer.test.ts`: three-source precedence — `transcript`(3) beats `payload`(2) beats `spawn`(1); a `payload` event arriving AFTER a `TranscriptTitle` with a different value does NOT clobber; re-fold determinism with synthetic + lifecycle events interleaved; SessionStart seeds `transcript_path` from `event.data`.

## Acceptance

- [ ] `SCHEMA_VERSION === 5`; `jobs.transcript_path` exists, backfills NULL on pre-v5 rows, migration idempotent across re-opens (v4→v5 test passes)
- [ ] `TITLE_PRIORITY` includes `transcript: 3`; `titleSourceForEvent` maps `TranscriptTitle`→`transcript`, everything else→`payload`; precedence write block unchanged
- [ ] A hand-inserted `TranscriptTitle` synthetic event (title in `data.session_title`) folds into `jobs.title` at priority 3, beating payload/spawn; a later `payload` event does not clobber it
- [ ] Re-fold from scratch reproduces identical `(title, title_source)` with synthetic events in the log
- [ ] SessionStart seeds `jobs.transcript_path` from `event.data.transcript_path` (NULL when absent/malformed, never throws)
- [ ] `collections.ts` serves `transcript_path` on `jobs`, absent from `sortable`/`filters`
- [ ] `bun test --isolate`, `biome check`, `tsc --noEmit` all clean

## Done summary
Added priority-3 'transcript' title source: schema v4→v5 jobs.transcript_path (SessionStart-seeded), TITLE_PRIORITY transcript:3 + titleSourceForEvent resolver (precedence write unchanged), transcript_path served on jobs (display-only). Tests cover 3-source precedence, no-clobber, re-fold determinism, v4→v5 migration, and the SessionStart seed.
## Evidence
