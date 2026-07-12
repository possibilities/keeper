## Description

**Size:** S
**Files:** src/autopilot-worker.ts, docs/problem-codes.md, test/autopilot-worker.test.ts

A backstop for the guard: an advisory, producer-probed DETECT-ONLY surface that flags a
wrapped-cell task whose done-stamp landed with no provider-leg result envelope at the
task's `KEEPER_WRAPPED_ENVELOPE` path — evidence the wrapper skipped delegation. Advisory
only; never blocks a dispatch, never mints an operator jam.

### Approach

Model it on the existing DETECT-ONLY `stuck-sentinel: cwd-missing` precedent in
`src/autopilot-worker.ts`: a producer probe, not a fold. It MUST NOT read fs/wall-clock/
process-liveness inside any fold (re-fold determinism is sacred) — the probe runs on the
live producer path and surfaces an advisory row, exactly as the sentinel does. Add a
`docs/problem-codes.md` row mirroring the `no_route` format (code, surfacing command,
meaning, fix, read-only flag). Clears when the envelope later appears or on the same
mechanism the sibling sentinel uses.

### Investigation targets

*Verify before relying — planner-verified at authoring time; the repo moves.*

**Required:**
- src/autopilot-worker.ts — the `stuck-sentinel: cwd-missing` DETECT-ONLY producer probe to model on.
- docs/problem-codes.md — the `no_route` advisory row format.

### Risks

- Envelope durability: if the envelope lives in a session-scoped tmpdir cleaned on session end, a naive "done + no envelope" probe false-positives. Bind the probe to the task's stable `KEEPER_WRAPPED_ENVELOPE` path and its lifecycle (task 1), and treat a probe error as inconclusive (no flag), never a false alarm.

### Test notes

Faked producer state: wrapped task done + envelope present → no flag; done + envelope absent →
advisory flag; probe error → no flag (inconclusive). No fold reads fs/clock. No daemon/subprocess.

## Acceptance

- [ ] A wrapped-cell task done-stamped with no leg result envelope surfaces an advisory, producer-probed signal that never blocks dispatch.
- [ ] The detection performs no fold read of fs/wall-clock/process-liveness (re-fold determinism preserved); a probe error is inconclusive, not a flag.
- [ ] `docs/problem-codes.md` carries a row for the advisory mirroring the existing format.

## Done summary

## Evidence
