## Description

**Size:** M
**Files:** test/daemon.test.ts

### Approach

Audit all ~65 `openDb(` call sites in `test/daemon.test.ts` and classify each into
one of three buckets, then convert the first two and leave the third:

1. **mem-clone** — pure in-process single-connection (`const {db}=openDb(dbPath)` →
   seed events → `drain`/`drainToCompletion` → assert, no file reopen, no child
   process, no `-wal`/`-shm`/`statSync` on the path). Swap to `freshMemDb()` (same
   `{db,stmts}` shape). This is the dominant bucket and the bulk of the win.
2. **file-clone** — a second connection reopens the same path readonly (e.g. the
   multi-connection sites ~L657/676, and any seed-then-readonly pattern). Swap the
   writer's `openDb(dbPath)` to `freshDbFile(dbPath)`; leave the readonly reopen as
   `openDb(dbPath,{readonly:true})`.
3. **keep-migrate** (carve-out, DO NOT convert) — sites whose contract IS the real
   on-disk migrate/WAL: WAL high-water region (~L326-399 / `driveDrain` ~L346),
   `-shm`/`-wal` reopen (~L1210), and any `busyTimeoutMs`/manual-pragma timing site
   (~L745, ~L1139). Add a one-line inline comment on each kept site stating why it
   stays on `openDb` migrate.

Leave the ~9 genuine daemon-spawn/Worker tests (L781/847, L1511/2314,
L3568/3702/3733/3749/3799, Worker L2645/2683) UNTOUCHED in this task — they are
task `.2`'s decision. Keep all 96 tests in `test:full` and green.

### Investigation targets

**Required** (read before coding):
- test/helpers/template-db.ts:113 — `freshMemDb()` shape/contract
- test/helpers/template-db.ts:146 — `freshDbFile()`, the WAL-checkpoint at ~L152 that makes a readonly reopen safe; the pragma/`updated_at` caveats in the L36-44 / L71-73 doc comments
- test/reclaim.test.ts:51, test/restore-set.test.ts:42 — precedent swaps
- test/daemon.test.ts:81 — the `beforeEach` tmpDir/dbPath setup shared by all bodies

**Optional** (reference as needed):
- src/db.ts — `migrate()` runs only when `(migrate ?? true) && !readonly`; `freshDbFile` passes `migrate:false`

### Risks

- A site that LOOKS convertible but secretly reads `${path}-wal`/`-shm`, `statSync(dbPath)`, or reopens readonly will pass VACUOUSLY under `freshMemDb` (no file exists). Before swapping, grep each candidate body for `-wal`, `-shm`, `statSync`, `existsSync`, `readonly:true`, `busyTimeout` and route any hit to file-clone or keep-migrate.
- Pragmas don't serialize into the template: a converted body that needs `busyTimeoutMs` must re-apply it after the clone.
- `reducer_state.updated_at` is frozen + shared across clones — never assert per-test freshness on it.
- Sites destructuring `{db,stmts}` must keep `stmts`; a `{db}`-only swap throws on first `stmts` use.

### Test notes

Convert in batches; after each batch run `KEEPER_TEST_NO_GATE=1 bun test test/daemon.test.ts` and confirm pass count stays 96 / 0 fail. Final: time the whole file (target: order-of-magnitude drop from ~124.7s) and run `bun run test:full` green. Record the before/after time and a 3-bucket classification count in the Done summary.

## Acceptance

- [ ] Every `openDb(` site classified mem-clone / file-clone / keep-migrate; counts recorded in Done summary
- [ ] mem-clone and file-clone sites converted; carve-out sites kept on real migrate with an inline why-comment
- [ ] `KEEPER_TEST_NO_GATE=1 bun test test/daemon.test.ts` passes 96/0-fail and runs in a small fraction of ~124.7s
- [ ] `bun run test:full` green; no behavior assertion weakened to a vacuous pass
- [ ] The ~9 spawn/Worker tests left untouched for task `.2`

## Done summary
Converted ~37 single-connection openDb(dbPath) sites in daemon.test.ts to freshMemDb() template clones. Classification: 37 mem-clone (converted), 0 file-clone (none needed — all multi-connection sites are in the untouched spawn set), 7 keep-migrate/carve-out (4 WAL/checkpoint + busyTimeout sites with why-comments: 290/352/1148/1237; plus spawn/Worker/in-process-daemon tests left for .2). In-process suite time ~124.7s to 11.5s (~10.8x). test:full green 4513 pass/0 fail; 97 tests (spec said 96 — stale, 0 delta from this change). Also fixed stale freshDb()->freshMemDb() in CLAUDE.md+README and orthogonalized slow-tier vs real-git-allowlist guidance.
## Evidence
