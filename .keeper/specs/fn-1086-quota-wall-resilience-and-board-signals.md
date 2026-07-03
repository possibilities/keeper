## Overview

The account session-limit wall produced two distinct failures today with zero system
awareness: a worker fan-out died mid-flight this morning, and tonight the reconciler burned
three dispatch cycles re-launching workers into the wall (bind → instant death → ready →
re-dispatch) until a supervisor manually paused. Nothing distinguishes a quota death from any
other end, and nothing stops the churn. This epic gives the board an instant-death breaker
(sibling of the existing never-bound breaker), cause-agnostic by design — post-bind lifetime
is the signal, no transcript parsing — plus the two small board-signal residuals: verdict-flap
debounce and batch-reap semantics verification. Scoped OUT of src/exec-backend.ts so it runs
parallel to the dissolution epic (same-session file-overlap rule).

## Quick commands

- Simulate 3 consecutive sub-minute post-bind deaths for one key (fold test): a visible sticky appears and the key stops re-dispatching until retry
- `keeper watch --json` during a task completion: no completed→running→completed flap deltas

## Acceptance

- [ ] N consecutive instant post-bind deaths for a key mint a visible sticky (change-gate routed) and pause that key's re-dispatch until retry_dispatch
- [ ] When the pattern is board-wide (multiple keys tripping in a window), the board surfaces a needs-human-class signal naming the likely quota wall; never a silent churn loop
- [ ] Verdict transitions around completion no longer emit flap deltas (or the watch stream debounces them); the fn-1083-era flap repro is pinned by a test
- [ ] Batch-reap reclassification carries the landed reap reasons (verified; gaps fixed or filed)

## Early proof point

Task `.1` — the breaker is a pure decision over jobs timing data with two in-repo precedents
(never-bound threshold, DispatchFailed change-gate). If fold-side proves wrong for re-fold
cost, the producer-side change-gate shape is the fallback.

## References

- Evidence: fn-1083.2 tonight — three dispatch cycles into "session limit resets 11:20pm"; supervisor manual pause; inventory items 1/19/10 residue
- src/reducer.ts NEVER_BOUND_REASON breaker (threshold 3) — the sibling precedent; uses event ts only (fold-safe)
- src/autopilot-worker.ts createDispatchFailedGate — every new emit routes it
- src/dispatch-failure-key.ts — reason vocabulary, prefixes collision-free, assertNever
- Killed/DispatchExpired reap reasons + jobs.kill_reason fold (landed) — the timing + reason inputs
- Constraint: cause-AGNOSTIC detection (post-bind lifetime from event ts) — no transcript parsing, no exec-backend edits (file reserved by the dissolution epic this session)

## Docs gaps

- **plugins/keeper/skills/autopilot/SKILL.md**: the new breaker reason in the dispatch_failure enumeration + the quota-wall operator note (pause/resume-at)
- **docs/problem-codes.md**: only if the signal surfaces on a CLI envelope
