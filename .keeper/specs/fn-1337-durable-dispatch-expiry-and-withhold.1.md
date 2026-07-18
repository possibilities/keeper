## Description

**Size:** M
**Files:** src/daemon.ts, src/reducer.ts, test/reducer-projections.test.ts, test/autopilot-worker.test.ts, docs/adr/, docs/problem-codes.md, CONTEXT.md

### Approach

The heartbeat-cadence pending sweep gains a sibling Reaper scan over durable
claims: `state='acquired' AND session_id IS NULL` with NO surviving pending
row (single-source rule — a key with a pending row stays owned by the
existing sweep, so the two sources are disjoint by construction and the
never-bound counter can never double-bump; the landed parked-sticky
never-double-fires invariant holds for free). Expiry fires only when BOTH
the durable age since `acquired_at` exceeds the threshold AND a full
TTL-plus-grace has elapsed since the CURRENT boot — the boot re-anchor
gives any wrapper still cold-starting across the reboot a whole post-boot
bind window, closing the double-dispatch hazard without schema changes or
liveness probes (no launch coordinates survive on the claim). Mints ride
the EXISTING DispatchExpired plumbing (producer-only wall-clock; the fold
stays deterministic; malformed/null acquired_at folds to a safe no-op;
jitter spreads mass reboot expiry; a skew-grace margin guards NTP
corrections; legacy_unfenced and bound claims are explicitly out of scope).
Visible-first: the K-threshold trips the existing never-bound sticky.
Second step, self-heal for the provably-ownerless class ONLY (session NULL,
zero provider-leg ownership rows): IF an existing claim-mutation event
surface authorizes a producer-minted release for this class, wire it so the
slot frees without an operator; otherwise record the visible-only residual
in the ADR — never widen the write surfaces. Ship the ADR (amending 0070 §2
with the expiry carve-out and the self-heal boundary), the problem-codes
stale_attempts revision, and the CONTEXT.md "orphaned claim" entry.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/reducer.ts:5658,5747,5768,10303,4353 — the fold set (Dispatched dual-write, expiry feeder + alreadyFailed, bind-reset, the sole releasing fold)
- src/daemon.ts:893-1000,8077,12429+ — sweep planning/mint plumbing, boot truncate, sweep body; the sidecar record shape (buildPendingDispatchSweepRecords) for reboot-reap observability
- src/reconcile-core.ts:1596-1640 — the claim fence the orphan holds
- docs/adr/0070:31-34 — the clause the amendment carves

**Optional** (reference as needed):
- src/reducer.ts:~5855 dispatch_instant_death — the sibling durable breaker template
- test/reducer-projections.test.ts:3991-4033 — never-bound counter fixtures to extend

### Risks

- Expiring a claim whose wrapper later binds — the boot re-anchor is the guard; the bind-onto-expired path must degrade defined, never a phantom double-run
- A mint racing a same-cycle re-dispatch — ordering against supersede must be pinned in a fixture

### Test notes

The red test folds Dispatched, calls truncateEphemeralProjections explicitly,
advances the injected clock past every threshold, and proves today's sweep
never expires the orphan; green under the scan. Cover: boot re-anchor
(survivor binds inside the post-boot window and resets the counter), K-trip
to the sticky, jittered mass expiry bounded per tick, null acquired_at
no-op, re-fold equivalence of the minted events, and — if self-heal wires —
exactly-once release for the ownerless class and never for one with legs.

## Acceptance

- [ ] A crash-window orphan (durable claim, boot-truncated pending row) expires visibly within K heartbeat sweeps after the post-boot window, on both daemon-age and boot-anchor gates
- [ ] A wrapper binding inside the post-boot window resets cleanly and is never expired; bound and legacy claims are untouched
- [ ] The single-source rule keeps the never-bound counter single-bumped per cycle with the parked-sticky invariant intact
- [ ] The ADR amendment, problem-codes revision, and glossary entry land; self-heal is either wired for the ownerless class through an existing event surface or its residual recorded
- [ ] Named gates for reducer-projections and autopilot-worker pass with re-fold equivalence green

## Done summary

## Evidence
