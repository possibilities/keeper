## Description

**Size:** M
**Files:** scripts/test-full.ts, package.json, test/test-full.test.ts, CLAUDE.md, README.md, plugins/plan/README.md

### Approach

A small Bun orchestrator (scripts/test-full.ts) mirroring scripts/test-gate.ts's shape: a PURE suite-plan builder (which suites, script, cwd, env patch, timeout) unit-tested in-process, and a thin runner that spawns each suite SERIALLY via its existing script — root `bun run test` (cwd repo root; includes the && test:opentui leg), plan `bun run test` (cwd plugins/plan), python `python3 -m unittest discover -s tests` (cwd repo root — the suite imports keeper.api via python -m's cwd sys.path insertion; there is no tests/__init__.py), prompt `bun run test` (cwd plugins/prompt, last — it is the slowest). Output streams inherit with an === header per suite and a one-line verdict after (verdicts from EXIT CODES only — never parse counts; plan's test count drifts between runs). Aggregate with a boolean accumulator to exit 0/1.

Env contract: the orchestrator OWNS the tier — fast mode DELETES KEEPER_RUN_SLOW and KEEPER_PLAN_RUN_SLOW from every child env (both gates check defined-ness, so ambient shell values silently promote the tier otherwise); the test:full:slow variant injects KEEPER_PLAN_RUN_SLOW=1 (plan swaps to test:slow) and KEEPER_RUN_SLOW=1 (root). Bail: KEEPER_TEST_BAIL (any non-empty = on, default off) stops after the first failing OR timed-out suite. Timeouts: per-suite default 300s, env-tunable (KEEPER_TEST_SUITE_TIMEOUT_S); the slow variant's root suite gets a 600s budget. A timed-out suite must die as a PROCESS GROUP (the top-level kill bypasses test-gate's --no-orphans reaper — spawn each suite into its own group and kill the group; verify with a synthetic wedge in the unit tier via the pure planner, and manually once live). Failure classification: spawn ENOENT (missing python3/bun), unittest exit 2, and a python "Ran 0 tests" stdout (cheap scan) are all distinct-verdict FAILURES; an orchestrator-internal fatal exits non-zero loudly (test-gate.ts:85-90 precedent); Ctrl-C tears down the running child's group and exits non-zero.

Docs in the same commit: revise (not append) the CLAUDE.md test-isolation sentence to name test:full + the slow gates; consolidate README's test block (~685-706) in place pruning fn-id provenance on touch; one terse note in plugins/plan/README.md's test table.

### Investigation targets

**Required** (read before coding):
- scripts/test-gate.ts — the spawn/exit-code/pure-builder pattern to mirror; do NOT bypass it for the root tier
- test/test-gate.test.ts:12 — the in-process pure-builder test precedent
- package.json + plugins/plan/package.json + plugins/prompt/package.json — the existing scripts test:full composes
- test/pair-panel.slow.test.ts:28-30 — the defined-ness slow gate the env scrub must respect

**Optional** (reference as needed):
- test/helpers/retry-until.ts:17 — the docstring anticipating test:full thrash
- tests/test_api.py — the python import shape pinning cwd

### Risks

- Process-group semantics differ across runtimes — the requirement is behavioral (no orphaned descendants after a timeout kill), the mechanism is the worker's choice; document it in the script header
- The opentui leg is masked when the root fast tier fails (the && chain short-circuits) — acceptable, one verdict per suite; note it in the script header rather than restructuring root scripts

### Test notes

Unit-test the pure planner: suite order, cwd per suite, env scrub/inject per variant, bail cut, timeout budgets, verdict classification (ENOENT, exit 2, zero-tests scan, timeout). The runner itself is thin; one live `bun run test:full` (and one `test:full:slow`) run recorded in Evidence is the integration proof.

## Acceptance

- [ ] `bun run test:full` runs all four suites serially, per-suite verdicts, exit 1 if any fails; `test:full:slow` swaps the slow tiers
- [ ] Fast mode scrubs both RUN_SLOW vars; ambient shell values cannot flip the tier (unit-tested)
- [ ] Timeout kills the suite's process group; bail respects timeouts; classification failures are distinct verdicts
- [ ] CLAUDE.md sentence revised in place (lint green); README + plan README edits land; full fast suite green

## Done summary

## Evidence
