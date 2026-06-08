## Description

**Size:** M
**Files:** test/plan-worker.test.ts, test/transcript-worker.test.ts, test/daemon.test.ts, test/integration.test.ts

### Approach

Delete the tests whose failure mode is OS timing / runtime, not keeper
logic. For EACH deletion, confirm (and note in the commit) the surviving
test that covers OUR logic:
- **test/plan-worker.test.ts** — the 5 spawned-Worker tests (`:2670`,
  `:2734`, `:2840`, `:2924`, `:3525`), the 5 fn-737 latency/lever tests
  (`:3880`, `:3981`, `:4102`, `:4218`, `:4353`), and the
  "smoke: @parcel/watcher loads" test (`:3489`). The reflog WIRING is now
  covered by `.1`'s pure helpers. KEEP every pure `PlanScanner` /
  `reconcilePlanctlDirs` / `buildMissedWakeRecord` / `isDropError` test.
- **test/transcript-worker.test.ts** — the "@parcel/watcher loads" smoke
  (`:1133`) + the spawned-Worker shutdown test (`:1167`). KEEP the
  `scanFile`/`scanJobsForTitles`/line-parser/`matchApiError` tests (they
  cover the transcript-title seam).
- **test/daemon.test.ts** — ONLY the pre-warm FLEET smoke
  ("boot smoke: after main pre-warm, a fleet…", `:2588`). KEEP the pure
  `prewarmWatcherAddon` loader-invocation tests (`:2530`/`:2544`/`:2566`)
  and the in-process keystone.
- **test/integration.test.ts** — the 5 subprocess-daemon tests: `:333`
  (hook->fold; covered by `events-writer.test.ts` + in-process keystone),
  `:973` (transcript live title; seam covered by transcript-worker tests +
  reducer fold), `:1072` (rename-while-down boot scan; covered by
  `scanJobsForTitles` tests), `:1538` (downtime boot-sweep; covered by
  PlanScanner sweep + daemon boot-drain tests), `:1741` (exit-watcher
  SIGKILL; `killed` fold covered by reducer tests, exit detection by
  `exit-watcher-ffi.test.ts`). KEEP the 4 `withInProcessDaemon` survivors
  + the argv-assertion test.

Then clean up `integration.test.ts` dead scaffolding orphaned by the
deletions: `fireHook`, `readStream`, `daemonSpawnEnv`, `sandboxedBaseEnv`,
`victimLaunchers`, the `daemon` Subprocess var, `DAEMON_ENTRY`,
`HOOK_ENTRY`, the `waitForDaemon` import, and the daemon-reap / victim-reap
bodies in `beforeEach`/`afterEach`. KEEP `injectLifecycleEvent`,
`connectClient`, `gitInitPlanRoot`/`gitCommitPlanRoot` (used by the
plan-fold survivor).

### Investigation targets

**Required** (read before coding):
- test/integration.test.ts — confirm exactly which module-level helpers go dead after the 5 deletions (grep each helper's remaining callers)
- test/events-writer.test.ts — confirms the hook half of `:333` is covered
- test/exit-watcher-ffi.test.ts + test/exit-watcher.test.ts — confirm exit-detection coverage for `:1741`
- test/reducer.test.ts — confirm `killed` semantics + TranscriptTitle fold coverage

### Risks

- Don't over-delete: the pure `prewarmWatcherAddon` loader tests and
  `isDropError` are NOT OS-coupled — keep them.
- Accepted: live-FSEvents transcript-tail, real SIGKILL stitch, real
  subprocess boot, and addon-LOAD lose dedicated coverage (the OS layer).

### Test notes

- After deletion, each of the 4 touched test files runs green on its own.
- Grep the repo for any now-unused imports/helpers left by the deletions.

## Acceptance

- [ ] The listed OS-coupled tests removed from all 4 files; pure/in-process survivors (incl. `isDropError`, pure `prewarmWatcherAddon` loader tests, the 4 in-process integration tests) retained
- [ ] Each deletion's OUR-logic coverage cited as surviving elsewhere (in the commit body)
- [ ] `integration.test.ts` dead scaffolding removed; no unused imports/helpers remain
- [ ] Each touched test file passes when run individually

## Done summary

## Evidence
