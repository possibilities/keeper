## Description

**Size:** S
**Files:** `src/db.ts`, `plugin/hooks/events-writer.ts`, `CLAUDE.md`, `README.md`

### Approach

Extend `OpenDbOptions` (`src/db.ts:544-546`) with a new optional field `migrate?: boolean` defaulting to `true`:

```ts
export interface OpenDbOptions {
  readonly?: boolean;
  migrate?: boolean; // default true; pass false from hook callers
}
```

In `openDb` (`src/db.ts:2358-2380`), gate the existing `migrate(db)` call at line 2375 on the new flag:

```ts
if ((options.migrate ?? true) && !readonly) {
  migrate(db);
}
```

The existing `!readonly` guard at line 2374 stays — readers never migrate. `applyPragmas(db)` (line 2372) and `prepareStmts(db)` (line 2378) remain unconditional — the hook still needs PRAGMAs (connection-local; `busy_timeout = 5000` etc.) and `prepareStmts` for `insertEvent`.

Flip the single hook call site at `plugin/hooks/events-writer.ts:419`:

```ts
const { db, stmts } = openDb(resolveDbPath(), { migrate: false });
```

All other `openDb` callers (daemon, server-worker reader, server-worker writer, plan-worker, transcript-worker, exit-watcher, tests) are untouched — they fall through to `migrate: true` and behave exactly as today.

Documentation:
- **CLAUDE.md** "Migrations are forward-only" section: append "The daemon is the SOLE migrator; the hook (`plugin/hooks/events-writer.ts`) opens with `{ migrate: false }` and never runs schema convergence. A hook arriving against a missing/stale schema fails its INSERT and exits 0 per the 'never block Claude' contract — silent event loss is the accepted failure mode."
- **README.md** install section: add a note that the daemon must boot at least once before the hook can write events (the LaunchAgent at `~/Library/LaunchAgents/arthack.keeperd.plist` handles this on login; manual `launchctl bootstrap` works for first install). This invariant existed implicitly before — the change makes it explicit.

### Investigation targets

**Required** (read before coding):
- `src/db.ts:544-546` — `OpenDbOptions` interface to extend
- `src/db.ts:566-572` — `applyPragmas`; STAYS unconditional (the hook needs `busy_timeout`)
- `src/db.ts:623-...` — `migrate` function body; the call we're gating
- `src/db.ts:2299` — `prepareStmts`; STAYS unconditional (the hook needs `insertEvent`)
- `src/db.ts:2358-2380` — `openDb`; the 2-line edit to the `migrate(db)` call
- `plugin/hooks/events-writer.ts:419` — single hook call site to flip
- `plugin/hooks/events-writer.ts:464-478` — hook's outer try/catch + exit-0 guard; preserves "never block Claude"
- `CLAUDE.md` — find the "Migrations are forward-only" rule under the "Event-sourcing invariants" section
- `README.md` — install section (around the existing `launchctl bootstrap` line)

**Optional** (reference as needed):
- All other `openDb` callers — verify by `grep -n 'openDb(' src/ test/` that none currently pass `{ migrate: false }` and that the default fallthrough preserves them

### Risks

- **Hook runs before daemon ever boots.** Pre-change: hook silently creates+migrates the schema. Post-change: hook's `prepareStmts` fails on missing tables; outer try/catch logs to stderr and exits 0. Event lost. Documented in CLAUDE.md + README; failure mode acceptable per hook contract.
- **Daemon mid-migration when hook fires.** Pre-change: both would contend on writer lock and serialize via `busy_timeout = 5000`. Post-change: hook just inserts (assuming schema is current); if schema is mid-ALTER, the prepared INSERT may hit a stale column; failure exits 0. The `busy_timeout` still applies. Acceptable.
- **Forward-only invariant becomes "must boot daemon first."** Operationally this matches today's behavior on a fresh install (LaunchAgent runs daemon at login, before any Claude session starts). Documented explicitly.

### Test notes

- Add a test that opens a freshly-migrated DB, closes it, reopens with `{ migrate: false }`, confirms `applyPragmas` left `busy_timeout != 0` (PRAGMA query), and confirms `stmts.insertEvent.run(...)` succeeds against the live schema.
- Optional negative test: open a brand-new empty DB with `{ migrate: false }`, confirm `prepareStmts` throws (since `events` table doesn't exist). Wrap in try/catch in the test; matches the hook's outer-guard tolerance pattern.
- Verify no regression in `test/events-writer.test.ts` and `test/db.test.ts`.

## Acceptance

- [ ] `OpenDbOptions.migrate?: boolean` field added; default `true` preserves all existing callers
- [ ] `openDb` gates the existing `migrate(db)` call on `(options.migrate ?? true) && !readonly`
- [ ] `applyPragmas(db)` and `prepareStmts(db)` remain unconditional
- [ ] Hook (`plugin/hooks/events-writer.ts:419`) passes `{ migrate: false }`
- [ ] No other `openDb` caller changes
- [ ] CLAUDE.md "Migrations are forward-only" section explicitly names the daemon as sole migrator
- [ ] README install section notes daemon-must-boot-first
- [ ] Test confirms `migrate: false` path works against a daemon-migrated DB and that `applyPragmas` still ran
- [ ] `bun test` green

## Done summary

## Evidence
