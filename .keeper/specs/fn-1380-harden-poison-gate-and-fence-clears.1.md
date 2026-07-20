## Description

**Size:** M
**Files:** src/daemon.ts, src/rpc-handlers.ts, src/server-worker.ts, cli/autopilot.ts, test/daemon.test.ts, test/rpc-handlers.test.ts, docs/problem-codes.md

### Approach

The operator dispatch-clear path (retry_dispatch) must refuse to release
a live worker's claim. Today the fence compares attempt identity
snapshotted at append, so an operator retry racing its own re-mint
clears the LIVE attempt, and the reply path reports ok:true even for a
fenced no-op. Contract: before appending a DispatchCleared for an
attempt with a bound, unreleased claim, probe the claimant's process
identity producer-side (never in a fold); a live or uncertain probe
refuses with a typed outcome threaded through the retry reply to the
CLI so the operator sees refused/needs-force instead of silent success.
--force overrides the liveness refusal ONLY — the attempt-identity CAS
at the write site stays load-bearing under force (else force
re-introduces the lost-update bug). Force and refusal are audited in
the event data (acting identity, target attempt, forced flag) and
replay byte-identically; the fold applies the committed event
unconditionally. The fence guards the operator path; prove the internal
level-triggered sweeps never delete a live bound attempt's mint gate
(a deleted live gate risks double-dispatch). Update the
stale-attempts recovery text in problem-codes.md: the clear now
self-refuses, so TERM-confirm-dead is no longer a manual precondition.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/daemon.ts:510-618 — DispatchClearFences, snapshotDispatchClearOwners, appendFencedDispatchClear (the CAS site; single-writer serialized)
- src/daemon.ts:10042-10069 — the operator retry path that ignores mintDispatchClearedEvent's bool and replies ok:true (the latent silent-success bug)
- src/db.ts:5825 — dispatch_claims schema (session_id, state, attempt_id, bound_at; NO pid — join to a projection carrying process identity)
- src/commit-work/process-identity.ts:222 — recordedProcessIdentity (the recycle-safe probe; prefer over bare pidAlive)
- src/server-worker.ts:424 — decideAwaitCancel (the pure append|noop|refuse decision-function shape to copy; ADR 0072)
- src/daemon.ts:9212 — the internal sweep callers of the clear (recover pass, gcUnretryableDispatchFailures) whose non-interference needs a regression proof

**Optional** (reference as needed):
- cli/autopilot.ts:718,1334 — buildRetryFrame + the CLI reply surface
- src/rpc-handlers.ts:1006-1017 — RetryDispatchParams stray-key rejection (where force/caller_session thread in)

### Risks

- Pid-reuse false-alive is safe (over-refusal); false-dead releases a live claim — refuse on uncertainty, prefer process identity over pid liveness
- Deleting a live attempt's dispatch_mint_gate in appendFencedDispatchClear risks double-dispatch — the sweep-non-interference proof is part of this task
- dispatch_failures is deterministic-replayed: the liveness decision lives at the producer; no probe may reach a fold

### Test notes

Pure seams: drive the decision function with seeded claim rows + a pid
probe seam (PROBE_DEAD/PROBE_ALIVE precedent in test/daemon.test.ts
3960-4120); assert refusal without force, clear with force, CAS refusal
under force when identity moved, typed outcome in the reply message, and
the internal-sweep non-interference invariant.

## Acceptance

- [ ] A clear naming an attempt whose claim is bound and whose session probes live (or uncertain) refuses without force, and the refusal reaches the CLI as a typed outcome, never ok:true
- [ ] --force clears through a liveness refusal but still refuses when the attempt identity no longer matches at the write site
- [ ] Forced and refused clears are audited with acting identity in event data, and re-fold reproduces them byte-identically
- [ ] A regression proof shows internal sweeps never delete a live bound attempt's mint gate
- [ ] The stale-attempts operator recovery text states the self-refusal contract

## Done summary
Confirmed the already-committed operator dispatch-clear liveness fence (commit 77110d640): retry_dispatch now producer-side probes claimant liveness before appending DispatchCleared, refuses live/uncertain claims with a typed refused_live outcome (never silent ok:true), --force lifts only that gate while the attempt-identity CAS still returns refused_identity on a stale attempt, audits acting identity + forced flag into re-fold-inert event data, and a regression test proves the internal orphan sweep never deletes a live bound attempt's mint gate. problem-codes.md's stale_attempts recovery text now states the self-refusal contract. Verified via an independent provider-leg run: targeted tests (daemon/rpc-handlers/autopilot) 610 passed, 0 failed; full suite 12,381 passed, 38 skipped, 0 failed.
## Evidence
