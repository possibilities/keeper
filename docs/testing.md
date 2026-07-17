# Testing

Keeper's correctness gates are deterministic, bounded, and lock-free. Use the named
commands below; each gate validates the test manifest and fails when a required package,
phase, or test set is absent.

## Run a gate

| Scope | Command | Includes |
| --- | --- | --- |
| Root fast gate | `bun run test:gate` | Root fast-test manifest phase. |
| Root default gate | `bun run test` | Root fast gate, then the serial OpenTUI phase. |
| Repository gate | `bun run test:full` | Root default gate, plan gate, and prompt gate, serially. |
| One root test | `bun test ./test/test-gate.test.ts` | An explicit `*.test.ts` target. |

Do not invoke bare `bun test`: the entrypoint rejects aggregate discovery before test
discovery. A direct `bun test` command is permitted only with one or more explicit
`*.test.ts` paths. Directories, globs, filters without a file, watch mode, and coverage
options do not make an aggregate invocation valid.

## Package and OpenTUI phases

The manifest has four nonempty phases: root, plan, prompt, and OpenTUI. It classifies
every discovered test file, so adding a test requires putting it in its package test
directory and maintaining the OpenTUI allowlist when applicable.

```sh
(cd plugins/plan && bun run test:gate)
(cd plugins/plan && bun run test)
(cd plugins/prompt && bun run test:gate)
(cd plugins/prompt && bun run test)
bun run test:opentui
```

The plan and prompt `test` scripts run their respective named fast gates. `test:opentui`
runs the explicit OpenTUI files in a serial, non-isolated phase because their native
runtime requires one shared loader context.

## What the gates prove

Keep correctness tests in-process and deterministic: inject clocks, schedulers, process
runners, storage operations, and cleanup decisions; poll for asynchronous state rather
than sleeping; and sandbox real state under the test temporary directory. Use migrated
template clones for current-schema consumers and run the migration ladder only when
migration behavior is under test.

The fast gates retain compact proofs for migration ladder shape and fingerprint,
zero-to-head and latest-transition migration, representative destructive and backfill
behavior, downgrade refusal, reopen and idempotence, deterministic re-fold equivalence,
retention keep-set safety, and small file-backed SQLite persistence or corruption
contracts. Correctness gates contain no opt-in slow tier, real-git promotion gate,
end-to-end journey, tmux, detached-process, production-scale, wall-clock, or fold-cost
growth-curve proof — see Slow tier below for the three gates that do.

## Slow tier

Three named gates run OUTSIDE the correctness gates — opt-in, never part of
`test:gate` / `test` / `test:full`, and never lock-free-violating. Two boot real
subprocesses; the third is a pure in-process perf bench that shares the fast gates'
`freshMemDb` + `drain` path and earns its own gate solely because timing assertions
are noisier than correctness assertions, not because it touches any real-process
boundary:

| Gate | Command | Proves |
| --- | --- | --- |
| Real-git publication | `bun run test:slow-git` | `commit-work`'s atomic publication against a real git subprocess. |
| Real-daemon smoke | `bun run test:slow-daemon` | A sandboxed real keeperd boot and catch-up, the served frame/probe contract, killing a real worker, and the restart CLI's evidence verdict, end to end (ADR 0073). |
| Fold-cost bench | `bun run test:bench-folds` | The reducer's growth curves stay pinned: the epic-fold memoized index-serving path flat in board size, and the `syncPlanLinks` per-session commit-trailer prefix cost inside a documented regression band. |

The real-git and real-daemon gates sandbox every state class under a per-run tmpdir
and boot real subprocesses (git, a keeperd, its workers) — never the host daemon,
never host-wide state or locks. Each owns a hard parent wall-clock deadline that
force-kills a hang into a bounded red result rather than a wedge, and absorbs one
disclosed retry to cover environment noise; a second failure is red. The fold-cost
bench carries no subprocess or sandbox surface at all — it lives entirely inside one
`bun:sqlite` `:memory:` connection per size step, bounded only by bun test's own
`--timeout` flag; a flaky ratio-band assertion is widened, never chased by tightening
the runtime.

Epic close-finalize runs `test:slow-daemon` automatically, but only when the epic's
landed diff touches the daemon Load surface — membership decided by
`scripts/daemon-load-roots.txt`, the same manifest the install reload fingerprint
hashes, so the gated and the hashed boundaries can never disagree. An epic whose diff
does not touch the Load surface finalizes unchanged; neither `test:slow-git` nor
`test:bench-folds` carries a finalize conditional of its own. A smoke failure surfaces
through the same finalize-suite-red operator path as a red merge-suite gate — a
visible sticky `dispatch_failures` row, never a silent skip — which an operator clears
with `retry_dispatch` once fixed.

## Diagnostics and policy checks

Run the fast-test policy check when changing test code:

```sh
bun run lint:fast-tests
```

Run the guardrail-doc check after editing `CLAUDE.md` or `README.md`:

```sh
bun run lint:claude-md
```

A configured small panel can be exercised as a manual, non-blocking operator diagnostic:

```sh
bun scripts/panel-smoke.ts --panel <small-panel> --outer-timeout 120
bun scripts/panel-smoke.ts --panel <small-panel> --outer-timeout 120 --abort-after 5
```

Manual diagnostic output informs operator investigation; it is not a correctness-gate
verdict.

## Timing budgets

Each named gate reports monotonic stage and total timings. Exceeding an objective warns;
the hard ceiling is enforced only by a qualified reference run.

| Gate | Objective | Enforced ceiling |
| --- | ---: | ---: |
| `test:gate` | 10 s | 15 s |
| `test` | 12 s | 18 s |
| `test:full` | 20 s | 30 s |

Run the repository budget check on the qualified reference host:

```sh
KEEPER_TEST_ENFORCE_BUDGET=1 bun run test:full
```

Budget enforcement requires macOS arm64 with Bun `1.3.14`; the command fails on another
host rather than treating an unqualified measurement as a budget result.
