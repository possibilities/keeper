## Overview

Trunk breakage is currently detected only when a worker trips over it, baselines, and blocks — hours after the bad merge. The baseline machinery (request spool, single-slot worker, keyed leafs with flake classification) already exists but is demand-driven. This epic auto-spools a baseline request on each new default-branch tip and, on a confirmed-red result, proactively mints a repair candidate feeding the existing SHARED_BASE_BROKEN→repair route — no worker casualty required. Includes reconciling the two meanings of "base green" (checkout cleanliness vs suite result) in the repair sweep's clear gate.

## Quick commands

- `bun test test/daemon.test.ts test/autopilot-worker.test.ts`
- Post-deploy: land a commit on main and watch `ls ~/.local/state/keeper/baselines` grow a leaf for the new tip

## Acceptance

- [ ] A new default-branch tip yields a baseline computation without any worker involvement, coalesced to the latest tip per repo
- [ ] A confirmed-red baseline (re-run confirmed, not flake-suspect) mints a repair dispatch candidate with zero blocked tasks
- [ ] An infra-error/timeout leaf never mints a repair candidate
- [ ] The repair clear-gate's notion of green is explicit and single-sourced

## Early proof point

Task that proves the approach: `.1` (tip-triggered spooling). If a second spool writer proves too invasive: the producer can shell the existing `keeper baseline` CLI as the request path — the sole-writer rule then holds by delegation.

## References

- docs/adr/0005-suite-baseline-store.md — the compute-once/demand-driven decision this amends (tip-triggered trigger model); record the amendment
- CLAUDE.md sole-writer rules — `keeper baseline` as sole spool writer must be re-scoped in the same change
- Incident: trunk red for ~8h, detected only via three worker SHARED_BASE_BROKEN blocks; repair route starved (fn-1198.1)
- Evergreen-trunk practice: page on the tested merged state; tolerate first-flaky-red; never re-validate an already-tested tip [practice-scout]

## Docs gaps

- **CLAUDE.md**: sole-writer rule re-scope + one Autopilot clause for the tip-triggered producer
- **docs/adr/0005**: amendment for the trigger-model change
- **CONTEXT.md** (Baseline, SHARED_BASE_BROKEN entries): confirm the daemon-initiated path still fits the definitions; extend SHARED_BASE_BROKEN's wording if candidate-with-no-worker stretches it

## Best practices

- **Confirmed-red only**: a single run has no flake signal; require the confirming re-run before repair dispatch [practice-scout]
- **Coalesce to latest tip**: a single-slot worker must never queue every intermediate tip [gap-analyst]
