## Description

**Size:** M
**Files:** test/daemon.test.ts, test/exit-watcher.test.ts, test/exit-watcher-ffi.test.ts, test/wake-worker.test.ts, test/maintenance-worker.test.ts, test/events-ingest-worker.test.ts, test/board.test.ts, test/autopilot.test.ts, test/git.test.ts, test/jobs.test.ts, test/usage.test.ts, test/history-read-verbs.test.ts, test/agent-tty.test.ts, test/plan-worker.test.ts, test/plan-contract.test.ts, test/commit-work-foundation.test.ts

### Approach

Cut the individual `test()`s that boot real infra, keeping each file's pure
in-process tests. Per the repo-scout inventory: daemon.test.ts
(`withInProcessDaemon` at 3635/3769/3800/3816/3866, `new Worker` at 2698/2732,
`Bun.spawn(bun --eval)` at 824/890 — KEEP the bounded `spawnSync(ps,timeout:500)`
at 1560 and `runArchiveScript` at 2358); the `new Worker` tests in
events-ingest-worker:829, wake-worker:215, maintenance-worker:171, exit-watcher
(210/248 + `spawn(sleep)` 241), exit-watcher-ffi (78/107/149 `spawn(sleep/true)`);
the `bun <cli>` CLI-subprocess tests in board:1913, autopilot:1204, git:67,
jobs:1141, usage:1515, history-read-verbs:51; agent-tty (28/119/125
`spawn(script/sh)`). For the real-git NON-slow files (plan-worker — also the
secondary spin suspect via its real `PlanScanner` fs walk + real git;
plan-contract; commit-work-foundation; git.test.ts's `bun <cli> git`), cut the
real-git tests — whole-file delete if the file is entirely real-git, surgical
if mixed. **Triage the ~45 currently-path-ignored files**: most are pure-unit
and only need their path-ignore dropped (task .5 does the removal) — flag any
that are secretly slow/infra. Validate the migrate-heavy `db.test.ts` stays
under the 10s per-test cap under `--parallel=5` load before it is promoted. If
a file empties to an imports-only husk after cuts, whole-file delete it.

### Investigation targets

**Required** (read before coding):
- The repo-scout inventory (per-file line numbers, keep-vs-cut, the bounded-spawn KEEP flags)
- test/restore-worker.test.ts, test/exec-backend.test.ts — the injected-stub pure-unit pattern that replaces a cut spawn test
- test/helpers/template-db.ts — `freshMemDb()` / `freshDbFile()`, the pure-unit DB constructors

### Risks

Files that empty to a husk should become whole-file deletes (and orphan their
helper imports — flag for task .5). The borderline bounded `bun`/`ps` spawns in
daemon.test.ts are KEEPs (bounded, can't hang). db.test.ts promotion is a 10s
flake risk under parallel load — measure before promoting.

### Test notes

After cuts, grep the touched files for any surviving `withInProcessDaemon` /
`new Worker` / `Bun.connect` / real-binary `Bun.spawn`. `bun test` green.

## Acceptance

- [ ] No surviving test() in the touched files boots a real daemon/Worker/socket/subprocess/git
- [ ] Real-git NON-slow files (plan-worker, plan-contract, commit-work-foundation, git.test.ts) carry no real git
- [ ] Husked files removed; the ~45 promote-set triaged (cut vs promote noted); db.test.ts measured <10s under load

## Done summary
Cut every real-infra/real-git test from the 16 in-process unit-core files: whole-file deleted agent-tty/history-read-verbs/plan-contract (entirely real infra), surgically removed the withInProcessDaemon/new Worker/bun --eval/real-subprocess/real-git tests elsewhere while keeping pure logic + bounded spawnSync KEEPs and pruning orphaned helpers/imports. Triaged the ~16-file promote-set (all pure-unit, safe; builds-watch/watchdog path-ignore entries are now no-op) and measured db.test.ts <10s/test under parallel-5 load. Touched files 559 pass / fast tier 3366 pass, 0 fail; biome clean.
## Evidence
