## Overview

The keeper TS suite (2,403 tests / 55 files) runs serially under `bun test --isolate` with no `--parallel`, costing ~98–141s wall and masking flakes. Turning on `bun test --parallel` (10 workers here) collapses the bulk run to ~7.5s (measured live, 0 fail, 2343 pass) once the two daemon-spawning files (`integration`, `daemon`) are carved into a serial slow tier. This epic lands a two-tier gate (fast parallel / slow serial / opentui unchanged), extracts shared test helpers, rewrites the heavy per-test on-disk WAL DB setup to `:memory:` where safe, consolidates real-git fixtures, thins redundant hook subprocess spawns, de-flakes the slow tier, and audits redundancy — while protecting every load-bearing invariant (re-fold determinism, hook exit-0, real-git trailer parsing, daemon lifecycle, six-path test isolation). Python (`tests/test_api.py`, 0.05s, stdlib unittest) is explicitly out of scope.

End state: `bun run test:fast` <10s and 0 flakes over 5 runs; `bun run test:slow` 0 flakes over 5 runs; the real `~/.local/state/keeper/` feed is never written during any test run.

## Quick commands

- `bun run test:fast` — parallel bulk tier, expect <10s, 0 fail
- `bun run test:slow` — serial daemon tier (integration + daemon), 0 flakes
- `bun run test:opentui` — unchanged 2-file TTY tier
- `bun run test` — fast && slow && opentui (fast failure surfaces first)
- `uv run python3 -m unittest discover -s tests` — Python, 41 tests / 0.05s, untouched

## Acceptance

- [ ] `test:fast` runs `--parallel` (no `--isolate` — redundant), excludes exactly integration + daemon + the two opentui files, <10s, 0 fail over 5 consecutive runs
- [ ] `test:slow` runs integration + daemon serially (NO `--parallel`), 0 flakes over 5 runs
- [ ] No test (parallel or serial) writes to the real `~/.local/state/keeper/` — every fast-tier file either sandboxes all six state paths or is pure in-memory
- [ ] All load-bearing invariants preserved: re-fold determinism tests stay on-disk where they need WAL; hook exit-0 / dead-letter / column-narrow stay real subprocess; git is never mocked; opentui split unchanged; `schema-version.test.ts` stays in the fast gate
- [ ] Python suite untouched (no pytest added)

## Early proof point

Task that proves the approach: task 1 (two-tier gate + fast-tier sandbox audit). It delivers the headline ~6.5x win and the pollution-safety gate immediately. If `--parallel` proves unstable even with the daemon files carved out: fall back to `--parallel` across the whole suite with explicit 30s timeouts, or pin a lower `--parallel=N`.

## References

- Charter: `~/docs/2026-06-06-fast-test-suites/keeper.md` (measured baselines, cut/keep/rewrite calls)
- Bun 1.3.14 fixed `--parallel`/`--isolate` segfaults; `--parallel` implies `--isolate` (file-level process concurrency, default CPU count)
- SQLite: every `new Database(":memory:")` is a SEPARATE db (no cross-connection visibility); WAL `journal_mode` is a no-op on `:memory:`
- Epic deps: none — all keeper epics fn-1..fn-720 are `done`, no open epics

## Docs gaps

- **CLAUDE.md (~lines 296-304, symlinked AGENTS.md)**: the test-isolation DO-NOT bullet names the six state paths and "a shared sandboxed base-env helper" generically — revise to cite `test/helpers/sandbox-env.ts` by path. Edit CLAUDE.md in place, never AGENTS.md.
- **README.md (~lines 431-445)**: env-var/spawn-test paragraph restates the KEEPER_* paths twice — consolidate to cite the helper file.

## Best practices

- **Drop `--isolate` from the fast tier:** `--parallel` already gives process-level isolation; keeping both is redundant overhead.
- **Readiness poll, not fixed sleep:** replace daemon-boot `Bun.sleep` waits with socket-exists + `Bun.connect` polls; but classify each sleep first — pacing sleeps (post-COMMIT, the WAL bounce-window mitigation) are load-bearing and must stay.
- **`git reset --hard` does NOT remove untracked files** — pair with `git clean -fdx` when reusing a repo across cases; keep `commit.gpgsign false`.
- **`:memory:` multi-connection trap:** two `:memory:` opens are two empty DBs — any test opening a second/readonly connection or asserting WAL must stay on-disk.
