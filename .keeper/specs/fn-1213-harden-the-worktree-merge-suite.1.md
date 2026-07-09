## Description

From audit findings F1 + F5 (merged): the production merge-suite gate probe
ships with no direct test coverage. Evidence path: `git grep` across every
test file returns ZERO references to `runMergeSuiteGate` (src/autopilot-worker.ts:5073),
`runPackageSuiteGate` (:5002), or `readPkgGateCommand` (:4977); the only
coverage is 8 injected-fake finalize tests (test/autopilot-worker.test.ts:11971-12112)
that exercise finalize's REACTION to a verdict, never how the probe MAPS real
runner results to a verdict. A regression there (e.g. a crashed merged build
folding to green/cannot-run instead of red) would ship uncaught.

Add unit tests injecting the existing seams (`run: WorktreeGitRunner`,
`worktreesRoot`, `installTimeoutMs`, `suiteDeadlineMs`) plus a fake suite
runner to assert each verdict branch:
- install-fail / install-timeout -> cannot-run
- no test-gate script (readPkgGateCommand -> null) -> cannot-run
- classifyRun == "crashed" -> red
- suite-timeout -> cannot-run
- a passing suite -> green
- root green + runsPlanSuite -> the plan-package suite is chained (runPackageSuiteGate called on the plan dir)
- the always-runs `finally` reaps the scratch worktree on EVERY path (green, red, cannot-run, thrown)

Files: src/autopilot-worker.ts (runMergeSuiteGate:5073, runPackageSuiteGate:5002,
readPkgGateCommand:4977), test/autopilot-worker.test.ts.

## Acceptance

- [ ] Each verdict branch above has an assertion driven through the injected `run`/suite seams
- [ ] Scratch-reap-on-every-path is asserted, including the thrown/error path
- [ ] `bun test` stays green

## Done summary

## Evidence
