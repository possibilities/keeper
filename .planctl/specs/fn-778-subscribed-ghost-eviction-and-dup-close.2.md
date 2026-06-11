## Description

**Size:** M
**Files:** src/autopilot-worker.ts, test/autopilot-worker.test.ts (plus whatever the diagnosis implicates)

### Approach

Diagnose-first, no hypothesis privileged. The facts: 2026-06-10 16:44:21 and
16:44:22, two `close::fn-608-squeegee-vtkeep-provenance-refs` workers launched
(job rows 06e392b0… and 4d3c67ae…, both reached working; epic in
/Users/mike/code/vtkeep). Daemon booted 16:12 that day and its server-worker was
at the conn cap through the window (rejections in server.stderr). Post-fn-762,
the dispatch-time cooldown stamp (stamped BEFORE the confirm await, in-memory
ReconcileState) plus the finalizer guard plus cycleRunning single-flight should
each independently prevent a second close launch 1s later. Establish from
evidence: the Dispatched synthetic events for this verb::id (ids + ts in the
events log), whether one reconcile cycle launched twice or two cycles ran, and
whether ANY suppression arm was consulted and missed. Candidate classes to test
against the code as found (not as remembered): (a) two reconcile cycles
overlapping despite cycleRunning (await interleavings in runReconcileCycle);
(b) the per-cycle dispatch loop launching the same verdict twice within ONE cycle
(dedup within the cycle's own candidate list); (c) stamp written after an await
point allowing an interleaved second stamp-check; (d) anything the conn-cap
condition could perturb (unlikely — dispatch is in-process — but verify the
dispatched-ack path under load). Fix what the diagnosis shows; pin with a test
reproducing the same-second shape (two ready close verdicts racing).

SECOND question (same investigation, cheap to answer en route): what governs
autopilot's paused state at boot? The 16:12 boot came up paused=0 while prior
boots (2026-06-09) came up paused=1. Read the boot re-arm path (fn-667 persisted
control state / the boot relay) and write the answer in Evidence; if boots are
supposed to be paused-by-default, make it deterministic and test it.

### Investigation targets

**Required** (read before coding):
- src/autopilot-worker.ts — runReconcileCycle dispatch loop, cooldown/finalizer stamp points, cycleRunning/wakePending single-flight, driveCycle
- the events log rows for the incident (sqlite, Dispatched/SessionStart for the two job ids) — establish the real timeline first
- src/daemon.ts — boot autopilot state relay (the paused-at-boot question)

### Risks

- Do not weaken any existing suppression arm while fixing; the fix must be
  additive or a corrected ordering, test-pinned against the fn-735/fn-742 suites.

### Test notes

A regression test that constructs two ready close verdicts for one epic in one
snapshot and asserts exactly one launch; plus whatever shape the diagnosis
dictates. Boot-pause determinism test if that leg finds a bug.

## Acceptance

- [ ] written verdict in Evidence naming the mechanism (with event-log timeline); fix landed; same-second reproduction test passes
- [ ] boot pause-state question answered (and made deterministic if buggy)
- [ ] fn-735/fn-742 suppression suites stay green; full bun test green

## Done summary
Root-caused the dup-close as slow-cold-boot over-dispatch (fn-762 recurring at a longer tail): a close::<epic> worker booted 317s late, its pending_dispatches row TTL-expired at ~120s with no jobs row bound, and the cooldown (single indoubt re-stamp, cover-end dispatch+260s) lapsed 2s before the re-dispatch at dispatch+261s. Fix: refreshSuppressionForOpenPending re-anchors the cooldown + finalizer guard each cycle a key still has an open pending row, tracking the phantom's durable (TTL-bounded) lifetime. Boot-pause leg: no bug — every boot comes up paused; the observed unpaused-at-boot was a human play RPC ~2s after the boot re-arm. Pinned by a same-second reproduction test + open-pending refresh/bound tests; full suite green.
## Evidence
