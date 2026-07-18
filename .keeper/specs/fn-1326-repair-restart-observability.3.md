## Description

**Size:** M
**Files:** src/restart-observation.ts, cli/restart.ts, test/restart-observation.test.ts, test/restart-cli.test.ts, test/helpers/daemon-smoke-harness.ts, test/slow/daemon-smoke.test.ts, docs/testing.md, docs/problem-codes.md

### Approach

Replace boolean health with structured served boot observations and drive restart success through the pure evidence model. Snapshot the old identity and ledger marker, issue kickstart once, then require the old identity gone and one different ledger-backed identity with completed Drain and consecutive healthy samples to remain unchanged for at least twelve monotonic seconds. A failed/timed-out kickstart is only a warning when the complete stronger proof succeeds; mismatched, unstable, unreadable, or inconclusive evidence returns bounded diagnostics and never triggers an automatic second kickstart.

Strengthen existing ADR 0073 scenario (c), not the closed scenario set: preserve predecessor ledger history, prove the served and ledger identities match, hold through stabilization, and retain the existing no-replacement negative control. Simulate fast replacement deterministically in the correctness tests rather than manufacturing a new crash loop.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- cli/restart.ts:147-168,238-359 — dependency seam, marker freshness, and socket health parser
- cli/restart.ts:361-460 — kickstart warning and current three-probe verdict loop
- test/restart-cli.test.ts:141-451 — deterministic success, warning, delayed-row, no-fresh-boot, and deadline fixtures
- test/helpers/daemon-smoke-harness.ts:119-292 — bounded sandbox daemon lifecycle and cleanup
- test/slow/daemon-smoke.test.ts:330-467 — existing controlled restart and no-respawn scenario
- docs/adr/0073-sandboxed-real-daemon-smoke-tier.md — amended scenario boundary
- docs/adr/0081-durable-boot-identity-and-stable-restart-verdict.md — exact success conjunction and stabilization interval

**Optional** (reference as needed):
- cli/envelope.ts — structured success/failure envelope conventions
- docs/problem-codes.md — restart recovery guidance if problem-code distinctions change

### Risks

- Three quick probes can still all precede a 9.8-second death; stabilization must measure from first caught-up observation
- Samples from B and C cannot combine after B dies; any identity change resets the proof
- launchctl PID output and `print` text are diagnostics, not stable correctness authority
- Slow coverage must keep its parent deadline and one disclosed retry without growing a new real-process scenario

### Test notes

Fast tests inject clock, health identities, ledger snapshots, process classification, launchctl results, and sleep. Cover exact success, replacement during stabilization, old identity surviving, row/health mismatch, unreadable evidence, no replacement, command warning with stronger proof, timeout, cancellation, and one-shot command count. The slow test uses sandboxEnv and retryUntil only.

## Acceptance

- [ ] Restart success requires the old recycle-safe identity gone, one different served identity, its durable row, completed Drain, and at least twelve monotonic seconds of unchanged healthy observations
- [ ] No health or ledger samples from different boots combine; an identity change resets proof and an old/new mismatch cannot succeed
- [ ] Kickstart executes exactly once; nonzero or timeout is retained as a bounded warning only when the complete stronger proof succeeds
- [ ] Missing, unreadable, mismatched, unstable, and no-replacement evidence return honest bounded failure diagnostics and recovery guidance
- [ ] The existing real-daemon restart scenario proves retained history, matching served identity, stabilization, and negative control under its parent deadline and cleanup contract
- [ ] Focused restart tests, the named slow-daemon gate, typecheck, and documentation lint pass

## Done summary
Replaced boolean restart health with structured served-boot evidence: the CLI now proves the old identity gone, one different ledger-backed served identity, completed Drain, and 12s of stable healthy observations before reporting success; kickstart fires exactly once, and mismatched/unstable/unreadable evidence returns bounded diagnostics without an automatic second kickstart. Strengthened the ADR 0073 sandboxed restart scenario and docs accordingly.
## Evidence
