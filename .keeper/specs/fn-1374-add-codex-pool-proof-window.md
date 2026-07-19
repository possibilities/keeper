## Overview

The landed codex-pool activation contract is circular: `activate` refuses anything but a fresh
proven report with all thirteen clauses, but pre-activation the companion runs native mode and
never builds the pooled delegate, so the nine routing/stream clauses are unobservable — an honest
proof run cannot exist (live-verified by the fn-1356 operator executor, which correctly refused
to fabricate). Add a sanctioned, bounded, explicitly-armed pre-activation proof window under
which the real `keeper agent pi` launch path engages the pooled delegate without persisted
activation, making the routing clauses observable for proof capture. Also land the transition
doctrine the live outage taught: enrollment revokes sibling grants (one live grant per account),
so the enroll verb must warn about the blast radius and the docs must order the transition
(enroll ⇒ expected native outage ⇒ prove + activate promptly).

## Quick commands

- `bun test ./test/codex-pool-activation.test.ts ./test/agent-account-routing.test.ts` — proof-window + enroll-warning suites green.

## Acceptance

- [ ] an operator can arm a bounded proof window pre-activation; within it, keeper-launched Pi exercises pooled routing observably; the window self-expires and never survives a daemon or session restart
- [ ] activation still refuses without a fresh complete proven report; the window changes observability, never the gate
- [ ] the enroll verb warns about grant revocation before starting OAuth, and the docs order the transition
- [ ] ADR 0090 is amended with the one-grant-per-account provider behavior and the accepted bare-pi end state

## Early proof point

Task that proves the approach: `.1`. If it fails: expose the pooled delegate behind a test-only injection seam and accept a harness-level (not live-path) proof, recording the downgrade in the ADR amendment.

## References

- fn-1356 operator verdict (bus artifact 0bf6fb71…): MODE=active only from persisted activation.json (src/agent/main.ts:4304); activate refuses non-proven reports (src/codex-pool-activation.ts:518-534); native mode never builds pooledDelegate (integrations/pi-codex-pool/src/index.ts:138-146)
- ~/docs/keeper-phase2-backlog.md item #60 (transition doctrine + mike's end-state decision)
