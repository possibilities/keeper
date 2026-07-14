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
end-to-end journey, tmux, detached-process, production-scale, or wall-clock proof.

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
