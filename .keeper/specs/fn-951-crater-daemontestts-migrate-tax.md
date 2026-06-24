## Overview

`test/daemon.test.ts` is the entire cost of the `test:full` tier — 96 tests /
~124.7s (~1.3s/test) — because ~62-65 `openDb(dbPath)` calls each re-run the full
`migrate()` ladder (SCHEMA_VERSION 86) on a fresh tmpdir DB. The fix is the
template-clone pattern the rest of the fast tier already uses: `freshMemDb()` /
`freshDbFile()` (`test/helpers/template-db.ts`) skip the ladder via
`Database.deserialize`. Converting the in-process sites is a near-mechanical,
zero-coverage-loss win; a small carve-out of WAL/migration-dependent sites and ~9
genuine daemon-spawn/Worker tests are handled deliberately. End state: `test:full`
runs in a small fraction of today's time, freeing the host-wide test flock that
currently serializes every concurrent agent's suite for ~2 minutes.

## Quick commands

- `KEEPER_TEST_NO_GATE=1 bun test test/daemon.test.ts 2>&1 | tail -3` — time the suite (was ~124.7s)
- `bun run test:full` — must stay green; account for the test count
- `bun run test:hygiene` — real-git allowlist guard must stay green
- `bun run lint && bun run typecheck`

## Acceptance

- [ ] `test/daemon.test.ts` in-process suite time drops by roughly an order of magnitude from ~124.7s
- [ ] `test:full` stays green; any change in test count is deliberate and accounted for (demoted tests still run in their tier)
- [ ] WAL/migration carve-out sites (WAL high-water ~L346, `-shm`/`-wal` reopen ~L1210, `busyTimeoutMs` pragma sites) are deliberately kept on a real `openDb` migrate, with an inline comment saying why
- [ ] Stale `freshDb()` references in CLAUDE.md (~L102) and README.md (~L670) corrected to `freshMemDb()`

## Early proof point

Task that proves the approach: `.1`. Convert the dominant single-connection
`const {db}=openDb(dbPath)` sites to `freshMemDb()` and re-time. If the in-process
time does NOT crater, the migrate-tax hypothesis is wrong — pivot to the second
suspect (per-test `mkdtempSync`/`rmSync` FS churn, or the one-time template build)
before touching the spawn tests.

## References

- `test/helpers/template-db.ts` — `freshMemDb()` (L113, returns `{db,stmts}` like `openDb`), `freshDbFile(path)` (L146, writes a migrated file + WAL-checkpoints so a readonly/spawned reopen works)
- `test/reclaim.test.ts:51`, `test/restore-set.test.ts:42` — precedent swaps (incl. readonly reopen)
- `test/helpers/in-process-daemon.ts:109` — `withInProcessDaemon`; `opts.workers` thins the per-boot worker set (does NOT share a boot across bodies)
- No inter-epic deps/overlaps (the open epics are all autopilot-behavior, disjoint file sets)

## Docs gaps

- **CLAUDE.md** (~L102) and **README.md** (~L670): `freshDb()` → `freshMemDb()` (stale name; the real export). Also orthogonalize CLAUDE.md's `*.slow.test.ts` guidance so slow-tier demotion and real-git allowlisting read as independent conditions.

## Best practices

- **Build the migrated template once, deserialize per test:** ~50µs/clone vs ~2s/migrate; this is the whole win. [bun:sqlite Database.deserialize]
- **Spawned/multi-connection tests need a FILE, not a `:memory:` clone:** use `freshDbFile()`, never `freshMemDb()`, anywhere a second connection or child process reopens the path. [bun:sqlite]
- **Don't WAL the template and don't blanket-convert:** pragmas don't serialize (re-apply explicitly), and WAL-high-water / `-shm` reopen assertions need a real on-disk migrate. [sqlite.org/wal]
