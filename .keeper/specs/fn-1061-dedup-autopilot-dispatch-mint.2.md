## Description

**Size:** S
**Files:** src/autopilot-worker.ts, test/autopilot-worker.test.ts, README.md

### Approach

Teach confirmRunning to recognize the suppressed ack from .1 and return
a NEW ConfirmOutcome (e.g. "suppressed-dup"): no launch, no
DispatchFailed mint, and — the load-bearing part — the cooldown glue
RE-STAMPS redispatchCooldown for the key instead of clearing it (the
aborted-prelaunch clear is what re-arms the amplifier; suppression must
damp, not re-arm). failedKeys is NOT set (the work is not failed; a live
attempt is presumed in flight or freshly minted). Revise the three
README passages in place per the epic Docs gaps: cooldown-clearing
outcomes table, EPHEMERAL-projections claims, and the boots-EMPTY
rationale (narrow it to the in-memory map).

### Investigation targets

**Required** (read before coding):
- src/autopilot-worker.ts:3414-3489 — confirmRunning outcomes + the crash-safety ordering comment; where the ack payload is interpreted
- src/autopilot-worker.ts:3778-3813 — the cooldown glue per outcome (clear vs keep vs re-stamp); the new arm goes here
- test/autopilot-worker.test.ts:394,408 — the ConfirmRunningDeps mock + mock emitDispatched to drive the suppressed ack

**Optional** (reference as needed):
- README.md ~3443-3448, ~2378-2382, ~2879-2889 — the three passages to revise in place (prune-not-append style)

### Risks

Outcome plumbing: every switch/exhaustiveness site over ConfirmOutcome
must handle the new variant — a missed arm is a silent misclassification
that could set failedKeys and stick the task.

### Test notes

confirmRunning with a suppressed ack → suppressed-dup outcome, no
launch call, cooldown re-stamped, failedKeys untouched; existing
ok/indoubt/aborted cases unchanged.

## Acceptance

- [ ] Suppressed ack → new outcome: no launch, no DispatchFailed, cooldown re-stamped, failedKeys untouched
- [ ] No suppress→clear→re-dispatch hot loop under a persistent pre-launch abort (test drives two cycles)
- [ ] All ConfirmOutcome consumers handle the new variant; bun run test green
- [ ] README passages revised in place per epic Docs gaps

## Done summary
Added the suppressed-dup ConfirmOutcome: a mint-gate-suppressed ack (ok:false,suppressed:true) yields no launch, no DispatchFailed, failedKeys untouched, and RE-STAMPS the redispatch cooldown so a persistent pre-launch suppression can't hot-loop. Revised the README cooldown-outcome table in place.
## Evidence
