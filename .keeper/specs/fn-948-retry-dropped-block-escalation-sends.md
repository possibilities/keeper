## Overview

The daemon block-escalation sweep currently mints `BlockEscalationAttempted`
unconditionally on a `send_failed` outcome, advancing the latch
`pending → requested → attempted`. Since `selectPendingBlockEscalations`
re-sweeps only `status='pending'` rows and the latch re-arms only on an
unblock→re-block transition, a transient bus failure at a 60s tick permanently
drops the escalation: the planner is never notified, the autopilot never
cold-re-dispatches, and the still-blocked task wedges silently. Make a failed
send non-terminal so the next sweep retries, and keep the board pill and await
softening truthful under that fix.

## Acceptance

- [ ] A `send_failed` outcome leaves the latch re-swept on the next tick (not terminally `attempted`), so a transient bus failure retries instead of dropping the escalation forever.
- [ ] The `[blocked:escalated]` pill and the await `--fail-on-stuck` softening reflect a genuinely-in-flight escalation, not a silently-bounced one.
- [ ] A test pins the chosen `send_failed` retry behavior end to end (a failed send is re-swept; a successful send is not).

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | daemon.ts:736 mints Attempted unconditionally on send_failed; selectPendingBlockEscalations (daemon.ts:456) re-sweeps only pending rows, so a transient bus failure permanently drops the escalation. |
| F2 | merged-into-F1 | .1 | F2 (coarse latch-presence reads in board.ts:520 / await-conditions.ts:266) shares F1's root cause and self-resolves once F1 keeps a failed send in flight. |
| F3 | culled | — | queued_for_wake substring match (daemon.ts:4067) is theoretical future-brittleness; CLI output is stable and tested. |
| F4 | merged-into-F1 | .1 | F4 (no end-to-end test that a send_failed stays un-re-swept) is the acceptance pin for F1's fix and folds into F1's task. |
| F5 | culled | — | distinct-epic fan-out (daemon.ts:677-708) is implemented correctly and implicitly exercised; the missing explicit test is coverage-completeness, not a defect. |

## Out of scope

- Replacing the `queued_for_wake` substring match with a structured signal (F3, culled — advisory, no current impact).
- An explicit distinct-epic fan-out test (F5, culled — the path works and is implicitly covered).
