## Overview

`keeper daemon restart` proves exact identity replacement for current daemons, but the first upgrade from a positively serving predecessor that lacks Daemon boot identity cannot satisfy the old-identity comparison and burns the full deadline after a healthy successor is already stable. Add the narrow ADR-backed compatibility proof without turning generic missing identity into success.

## Quick commands

- bun test ./test/restart-observation.test.ts ./test/restart-cli.test.ts ./test/restart-verb.test.ts
- bun run typecheck

## Acceptance

- [ ] A positively served identity-incapable predecessor can cross to one ledger-backed, caught-up, continuously stable identity-capable successor and return before the deadline
- [ ] Timeout, refusal, malformed/non-result framing, partial identity, and unreadable pre-ledger state never select compatibility proof
- [ ] The ordinary exact predecessor-disappearance and distinct-successor proof remains unchanged for identity-capable daemons
- [ ] Success identifies its proof path additively, while existing problem codes and command-warning precedence remain stable

## Early proof point

Task 1 first pins the pure evidence matrix for exact, positive crossing, and unavailable/ambiguous pre-state. If the parser cannot recognize the crossing without admitting partial identity, stop rather than broaden generic unavailability.

## References

- docs/adr/0086-positive-legacy-service-restart-crossing.md — accepted compatibility and anti-downgrade contract
- docs/adr/0081-durable-boot-identity-and-stable-restart-verdict.md — ordinary exact replacement proof preserved
- cli/restart.ts:175-185,327-429 — health evidence union, frame parser, and socket probe
- cli/restart.ts:506-543,576-790 — frozen pre-state, polling, success, and failure routing
- src/restart-observation.ts:51-68,268-505 — pure evidence model and exact proof classifier
- test/restart-cli.test.ts:137-380; test/restart-observation.test.ts:79-350 — deterministic parser/orchestration/verdict matrices

## Best practices

- **Explicit compatibility:** downgrade proof only from a complete recognized served response, never a transport or parsing failure
- **Frozen provenance:** capture predecessor capability and readable ledger membership before the single irreversible kickstart
- **Same successor bar:** retain durable identity, Drain, health, and twelve-second same-identity stabilization on both proof paths
- **Observable proof:** report which contract succeeded without weakening or repurposing failure codes
