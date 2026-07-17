## Description

**Size:** S
**Files:** cli/restart.ts, test/restart-cli.test.ts

### Approach

Make the restart verdict evidence-based: capture bounded stdout/stderr from the kickstart invocation into the envelope instead of discarding it, and on a nonzero kickstart status fall through to the existing health-probe loop rather than returning terminal `kickstart-failed` immediately. The success decision requires fresh-boot evidence — the restart ledger's newest boot entry postdating the pre-restart read — plus the existing consecutive-healthy-probe requirement; when both hold under a nonzero kickstart, return success with a typed kickstart warning in the envelope. `kickstart-failed` remains only for the case where no fresh healthy boot appears by the deadline (alongside the existing `health-timeout` distinction). Verified operator evidence: the ledger recorded healthy launchd boots at 13:49, 21:07, and 23:11 on 07-16 while the CLI reported `kickstart-failed`.

### Investigation targets

*Verify before relying — planner-verified file:line at authoring time, but the repo moves.*

**Required** (read before coding):
- cli/restart.ts:263-270 — the kickstart invocation and the early `failure("kickstart-failed", deps)` return this task removes
- cli/restart.ts:278-299 — the existing health-probe loop (`healthyInARow`) the nonzero path must fall through to
- cli/restart.ts:186-199 — the injected `probeHealth` seam; add a ledger-read seam beside it rather than reading the filesystem inline
- ~/.local/state/keeper/restart-ledger.json — append-only boot ledger (`{kind:"boot", boot_id, ts, provenance}` NDJSON) that supplies fresh-boot evidence

## Acceptance

- [ ] A nonzero kickstart followed by a fresh healthy boot returns exit 0 with the kickstart warning and bounded output in the envelope
- [ ] A nonzero kickstart with no fresh boot by the deadline still fails with the retained output
- [ ] A zero-status kickstart path is behaviorally unchanged aside from the retained output
- [ ] The focused test covers all three outcomes through injected kickstart/ledger/probe seams with no real daemon or launchctl

## Done summary
Restart verdict now requires fresh ledger-boot evidence alongside healthy probes; a nonzero kickstart that reaches a fresh healthy boot succeeds with a bounded kickstart_warning, while kickstart-failed is reserved for no fresh boot by the deadline and retains the bounded output.
## Evidence
