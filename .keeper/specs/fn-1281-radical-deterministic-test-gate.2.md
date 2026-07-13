## Description

**Size:** M
**Files:** src/baseline-worker.ts, src/autopilot-worker.ts, test/baseline-worker.test.ts, test/autopilot-worker.test.ts

### Approach

Replace the first-literal-`&&` package-script parser with direct lookup and invocation of `test:gate`. Baseline keeps raw-run classification and one retry for genuine suite-red; merge-finalize keeps root-first and conditional plan-package coverage. Thread timeout/kill-grace dependencies through the package-suite runner so timeout-path unit tests settle in milliseconds while production keeps its bounded grace.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/baseline-worker.ts:186-194,211-305,448-525,612-665 — script discovery, result parsing, bounded runner, and retry contract
- src/autopilot-worker.ts:6010-6151,6153-6228 — root/plan suite selection, scratch checkout, install, run, and reap flow
- test/baseline-worker.test.ts:276-299 — current first-phase pin
- test/autopilot-worker.test.ts:14287-14305 — merge-gate package-script pin

**Optional** (reference as needed):
- docs/adr/0005-suite-baseline-store.md — compute-once result and infra-vs-red distinction

### Risks

Missing or malformed named scripts must classify as infrastructure failure, never clean. Performance-budget warnings must not become Baseline red or wedge merge-finalize. Plan-package conditional coverage must survive the command change.

### Test notes

Drive missing script, clean, failed, crashed, timeout, retry, root-only, and root-plus-plan paths through injected runners. Set test kill grace to 5–10ms rather than paying the production five-second floor.

### Detailed phases

1. Add a typed named-script resolver.
2. Migrate Baseline and preserve result parsing/retry.
3. Migrate merge-finalize and preserve plan conditionality.
4. Inject timeout settlement controls and collapse elapsed-time tests.
5. Delete first-`&&` parser tests and code.

### Alternatives

Continuing to parse package shell text was rejected because script layout is not a stable interface.

### Non-functional targets

Unit timeout paths settle under 50ms; production output caps, process-group kill, scratch cleanup, and deadlines remain bounded.

### Rollout

Land only after task 1 names every consumed script. A missing named gate fails loud during skew rather than falling back to legacy parsing.

## Acceptance

- [ ] Baseline invokes root `test:gate` directly and preserves clean/failed/flaky-suspect/infra/timeout semantics.
- [ ] Merge-finalize invokes root `test:gate` and conditionally plan `test:gate` without parsing shell chains.
- [ ] Missing named gates fail as infrastructure errors and never read clean.
- [ ] Timeout-path tests use injected settlement controls and add no production-duration floor.
- [ ] Scratch checkout install/run/reap and bounded-output behavior remain unchanged.

## Done summary
Baseline and merge-finalize now resolve scripts["test:gate"] directly via a shared readTestGateCommand (baseline-worker.ts), replacing the old first-&&-segment scripts.test parser (gatePhaseCommand/readGateCommand/readPkgGateCommand, all removed). runPackageSuiteGate and runMergeSuiteGate now accept an injectable killGraceMs forwarded to runDetached, so the two merge-suite timeout tests in test/autopilot-worker.test.ts settle in ~5ms instead of padding bun tests per-test timeout to 8s for a real 5s production grace. A missing/malformed test:gate script still classifies as an infra error on both paths, never clean. Root/plan conditional suite coverage in runMergeSuiteGate is unchanged. Verified: bun run typecheck clean; bun test ./test/baseline-worker.test.ts (29 pass) and ./test/autopilot-worker.test.ts (628 pass) green in 3.5s; bun run test:gate full root pass (8781 pass/0 fail/34 expected skips). Landed as d05cc886.
## Evidence
