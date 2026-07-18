## Overview

Repair the three restart-observability contradictions without guessing at an unattributed death. First encode the evidence model that rejects old rows and mixed process samples; then make boot identity durable before readiness and preserve forensic history; finally require one ledger-backed, caught-up daemon identity to survive beyond launchd's throttle interval before the restart CLI reports success.

This epic follows the runtime-cycle split because the served boot-identity result touches `server-worker.ts`. The historical 9.8-second death remains explicitly unattributed unless primary evidence discovered during implementation proves a cause; timing proximity alone cannot authorize a lifecycle change.

## Quick commands

- bun test ./test/restart-observation.test.ts ./test/daemon.test.ts ./test/server-worker.test.ts ./test/restart-cli.test.ts
- bun run test:slow-daemon
- bun run typecheck

## Acceptance

- [ ] A pure evidence model rejects old-row readability, recycled processes, mixed-boot health samples, and replacement during stabilization
- [ ] Every admitted daemon appends durable boot identity before DB/Drain/readiness, preserves prior forensic history, and serves that identity on steady-state results
- [ ] Restart success proves one different ledger-backed identity, completed Drain, and at least twelve seconds of stable health without retrying kickstart
- [ ] The existing sandbox restart scenario proves retained history, matching served identity, stabilization, and the no-replacement negative control
- [ ] No lifecycle behavior is changed solely to explain the historical short death; genuinely unavailable cause evidence remains labeled unattributed

## Early proof point

Task that proves the approach: task 1. If the evidence classifier cannot distinguish a newly readable old marker from a new boot without served process identity, task 2's served identity becomes mandatory before any CLI integration proceeds.

## References

- docs/adr/0081-durable-boot-identity-and-stable-restart-verdict.md — binding durability and verdict contract
- docs/adr/0030-single-instance-gate-and-restart-provenance.md — single-instance and boot-id provenance contract
- docs/adr/0073-sandboxed-real-daemon-smoke-tier.md — amended controlled restart scenario
- ~/docs/keeper-review-remediation.md — operator incident chronology; read the restart-observability section before interpreting surviving host evidence

## Docs gaps

- **docs/testing.md**: consolidate the slow-daemon restart scenario around retained history, matching served identity, stabilization, and negative control
- **docs/problem-codes.md**: revise only if the restart result adds a distinct mismatch/unstable problem code or recovery action

## Best practices

- **Separate acceptance, incarnation, readiness, and stability:** launchctl completion alone proves none of the latter three
- **Append before readiness:** healthy service without durable boot identity is forbidden
- **One identity across evidence:** ledger, process, Drain, and health samples must bind to the same boot
- **No speculative repair:** unavailable exit evidence remains unattributed rather than becoming an inferred cause
