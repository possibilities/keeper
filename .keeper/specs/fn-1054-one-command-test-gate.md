## Overview

Root `bun run test` gates only the keeper fast tier — the plan plugin's ~1,500 tests, the prompt plugin's suite, and the python whitelist tests gate nothing, so a cross-cutting refactor can green root while breaking them. This epic adds a serial four-suite `test:full` orchestrator (plus a slow variant that unlocks the env-gated real-git/subprocess describes) and lands the small isolation fixes the test review surfaced.

## Quick commands

- `bun run test:full` — all four suites, ~2.5 minutes
- `KEEPER_TEST_BAIL=1 bun run test:full` — stop at first failing suite
- `bun run test:full:slow` — includes plan's real-git describes and the root slow file

## Acceptance

- [ ] One command runs root (incl. opentui), plan, python, and prompt suites serially with per-suite verdicts and exit 0/1 aggregation
- [ ] Fast mode scrubs KEEPER_RUN_SLOW/KEEPER_PLAN_RUN_SLOW from child envs; slow mode injects them — ambient shell values can never flip the tier
- [ ] A wedged suite dies as a process group on timeout, leaving no orphaned descendants
- [ ] The daemon.test.ts state-class violation, the misclassified fixed sleeps, and the stale test-file comments are gone

## Early proof point

Task that proves the approach: `.1` — the orchestrator's pure plan-builder unit-tests in-process (the buildBunTestArgs precedent), then one live `bun run test:full` run recorded in Evidence. If it fails: fall back to a plain package.json `&&` chain (loses reporting, keeps the gate).

## References

- Load-bearing: suites must run through their EXISTING scripts — a flattened `bun test` without the gate's --parallel/--isolate reproducibly breaks 28 tests
- Measured budgets: root ~45s, plan ~17s (slow ~83s, passes today), prompt ~85s (slowest), python ~1s
- The retry-until helper's 10s default was pre-provisioned for exactly this full-run thrash (its docstring names test:full)

## Docs gaps

- **CLAUDE.md** (Test isolation): the "bun test is the whole suite" sentence is revised in place to name test:full and the slow gates — no growth; lint-claude-md stays green
- **README.md** (~685-706): consolidate the test block in place; prune fn-id provenance on touch
- **plugins/plan/README.md** (test table): one terse note that root test:full orchestrates this suite

## Best practices

- **Run-all-report-all locally, bail as an opt-in flag** — the "what else is broken" picture is the point of a local gate
- **Per-suite cwd and explicit exit-code capture** — bunfig resolution is cwd-relative; unittest exits 2 on collection errors and 0 on zero tests, both need explicit classification
- **Stream child output inherit-style** — section headers before, one-line verdict after; no line prefixing in serial mode
