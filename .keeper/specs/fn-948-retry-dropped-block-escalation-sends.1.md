## Description

Fixes F1 (with F2 and F4 folded in). The block-escalation sweep
(`runBlockEscalationSweep`, `src/daemon.ts:656-737`) mints
`BlockEscalationAttempted{send_failed}` unconditionally at daemon.ts:736 on a
failed bus send. The `BlockEscalationAttempted` fold (`src/reducer.ts:4014`)
advances the latch to `attempted`, and `selectPendingBlockEscalations`
(`src/daemon.ts:456-461`) re-sweeps only `status='pending'` rows — so a
`send_failed` is terminal and the escalation is dropped forever (the latch
only re-arms on an unblock→re-block `TaskSnapshot` transition,
`reducer.ts:747/758`). Make `send_failed` non-terminal so the next sweep
retries: either skip the `Attempted` mint on `send_failed` to leave the latch
`pending` (the `foldBlockEscalationRequested` UPDATE at reducer.ts:3961 is a
safe re-mint — it just re-sets `requested` without a `pending` guard, so a
leave-pending shape re-notifies cleanly next tick), OR add a bounded retry
counter on the latch (the `dispatch_never_bound` precedent) so a permanently
flaky bus eventually gives up loudly rather than silently. Preserve the
escalate-once / re-fold-byte-identical guarantees and the producer-only-spawn
discipline.

F2 (folded): the `[blocked:escalated]` pill (`cli/board.ts:520, 289-294`) and
the await softening (`src/await-conditions.ts:259-267`) read latch presence
coarsely (any status), so a `send_failed` row falsely renders "planner
notified" and softens `--fail-on-stuck`. Under the leave-pending fix this
self-resolves (a failed send stays genuinely in flight); verify it does, or
read `outcome` so a terminally-failed row drops out of the escalated set.

## Acceptance

- [ ] A `send_failed` outcome no longer terminally advances the latch — the next sweep re-evaluates the row (or a bounded counter eventually surfaces a loud terminal failure).
- [ ] The board pill and await softening reflect a genuinely-in-flight escalation, not a silently-bounced one.
- [ ] An end-to-end test pins the behavior: a `send_failed` is re-swept on the next tick; a `sent`/`queued_for_wake` is not.
- [ ] Re-fold stays byte-identical (the `refold-equivalence.test.ts` guard holds) and the spawn stays producer-only.

## Done summary
Made the block-escalation send_failed outcome non-terminal: foldBlockEscalationAttempted now resets the latch to pending on send_failed (recording the outcome) instead of advancing to attempted, so selectPendingBlockEscalations re-sweeps it next tick and a transient bus failure retries instead of dropping the escalation. Board pill and await softening self-resolve since a failed send stays genuinely in flight.
## Evidence
