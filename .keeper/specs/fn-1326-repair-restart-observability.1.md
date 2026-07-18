## Description

**Size:** M
**Files:** src/restart-observation.ts, test/restart-observation.test.ts

### Approach

Create a pure, dependency-light evidence model for one restart invocation. It consumes the pre-restart served identity and ledger marker, structured current health observations, canonical ledger boot records, monotonic timing, and optional command diagnostics; it classifies missing, mismatched, mixed, unstable, and proven evidence without performing I/O. Use it to characterize the surviving trio: current compaction/rewrite explains history loss, swallowed persistence explains stats-without-row, and old-marker/mixed-sample acceptance explains false success; the short death remains `unattributed` absent primary exit evidence.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- cli/restart.ts:147-168,238-275 — current boolean health and ledger-marker seams, including `before === null`
- cli/restart.ts:361-460 — three-probe success loop and final evidence check
- src/daemon.ts:5061-5459 — canonical ledger parse/collapse/compaction and fail-open rewrite
- src/daemon.ts:8191-8205,9788-9909 — boot-id mint, late row persistence, and later Drain-stat write
- plist/arthack.keeperd.plist:68-77 — KeepAlive and ten-second throttle correlation
- src/proc-starttime.ts:1-68 — recycle-safe process start-time parsing
- src/exec-backend.ts:586-601 — existing alive/dead/recycled/unknown identity classifier

**Optional** (reference as needed):
- docs/adr/0081-durable-boot-identity-and-stable-restart-verdict.md — required state machine
- ~/docs/keeper-review-remediation.md — historical observations and evidence limits

### Risks

- Treating wall-clock proximity as causal evidence would bake the historical 9.8-second speculation into code
- A model that accepts booleans or PID-only evidence can still combine several daemon boots into one verdict
- “Missing” and “unreadable” ledger evidence need distinct diagnostics even though neither can prove success

### Test notes

Use synthetic observations only. Cover newly readable old marker after a null pre-read, recycled PID, old identity still alive, boot row without health, health without row, mismatched boot_id/start time, mixed consecutive samples, replacement inside stabilization, monotonic deadline, exact proof, and genuinely unavailable death cause.

## Acceptance

- [ ] The pure model requires one exact `{boot_id,pid,start_time}` across served health and a matching durable row, distinct from the pre-restart identity
- [ ] Newly readable old rows, PID reuse, missing/unreadable ledger evidence, mixed boot samples, and replacement during stabilization classify as non-success with bounded structured reasons
- [ ] The model separates command acceptance, process replacement, durable boot, Drain completion, health, and stabilization states
- [ ] Historical evidence records compaction/rewrite, swallowed write, and old-marker acceptance as demonstrated mechanisms while leaving the short death unattributed without primary cause evidence
- [ ] Focused deterministic tests pass without subprocesses, sockets, launchd, or sleeps

## Done summary

## Evidence
