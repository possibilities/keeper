## Overview

Autopilot worker agents wait many minutes on the test suite — a `bun test`
run that takes ~2.4 min alone balloons to 7-8+ min under concurrent host
load, and workers seen running ~30 min are mostly test suite. Two root
causes, both measured: (1) several agents run `bun test --parallel` (one
worker per core) at once and oversubscribe the CPU; (2) the suites do real
work that uses real CPU — real `git` invocations and real subprocess/binary
spawns. This epic tames both, across BOTH the keeper-root suite and the
plan-plugin suite. Pantera mode: ZERO real git anywhere in the default
tiers, no format-drift canary. Test keeper's DECISIONS at the git boundary
with synthetic inputs / faked runners, never git's execution. Losing test
coverage is explicitly acceptable; an unusable suite is not. End state:
`bun test`, `bun run test:full`, and the plan plugin's `bun test` spawn no
real git, no compiled binary, and no avoidable subprocess — and concurrent
runs serialize instead of thrashing.

## Quick commands

- `KEEPER_TEST_PARALLEL=4 bun run test:full` — full suite through the gate, capped + serialized
- `! grep -rlE 'Bun\.spawn(Sync)?\(\["?git|initRepo|gitInit|git init' test/*.test.ts | grep -vf scripts/test-real-git-allowlist.txt` — no real git in non-allowlisted keeper-root tests
- `cd plugins/plan && bun test --timeout 30000` — plan suite runs WITHOUT a prior `bun run build` (no binary spawn) and with no real git
- `bun run test:hygiene` — the no-real-git regression lint passes

## Acceptance

- [ ] `bun test` / `bun run test:full` route through `scripts/test-gate.ts`: a `--parallel` cap (env `KEEPER_TEST_PARALLEL`, default 4) + a host-wide flock so concurrent agent runs serialize; fail-open on timeout; `KEEPER_TEST_NO_GATE` bypasses the lock only
- [ ] The default keeper-root tiers invoke zero real `git` and spawn no avoidable subprocess (producers tested via synthetic porcelain/snapshot fixtures; commit/push surfaces tested via a faked git runner)
- [ ] The plan-plugin default `bun test` requires no `bun run build`, spawns the binary zero times (in-process `main(argv)`), runs no real git, and executes no shim binaries
- [ ] A regression lint fails if real git / `mkdtemp`+`initRepo` reappears in a non-allowlisted hot file; CLAUDE.md "Test isolation" documents the no-real-git convention
- [ ] Full suite wall-time is materially reduced and `bun test`/plan `bun test`/`test:full` stay green

## Early proof point

Task that proves the approach: the concurrency gate (task 1). It is
independently landable and delivers the instant-relief win (serialize +
cap) without touching any test logic. If it regresses a done-gate (exit
code / stdio), revert the two `package.json` script lines — the gate is a
thin wrapper.

## References

- OVERLAP: `fn-889-retire-planctl-name` (open, in-progress) writes `src/git-worker.ts` and `CLAUDE.md` — the same files this epic edits. Wired as an epic dependency so this epic sequences AFTER fn-889 lands to avoid the conflict.
- REVERSE-DEP (advisory): `fn-900` uses `bun run test:full` as a done-gate and benefits from a faster, more reliable suite; not hard-blocked.
- Reusable seams: `src/commit-work/flock.ts` `CommitWorkLock` (FD_CLOEXEC, caller-supplied lock path); `test/helpers/in-process-daemon.ts` `withInProcessDaemon`; `parsePorcelainV2` (already pure + synthetic-tested) and the `snap()`/`dirtyFile()` synthetic `GitSnapshotPayload` factory in `test/git-worker.test.ts`; `plugins/plan/src/cli.ts:1107` `main(argv): number`.
- Bun: `--parallel=<val>` takes N worker processes and implies `--isolate` (verified, Bun 1.3.14). `--max-concurrency` governs only `test.concurrent()` and is inert here.
