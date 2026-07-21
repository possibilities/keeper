## Description

Introduce one shared per-tick time budget for the periodic maintenance
passes that run on MAIN (retention shed, cold-history compaction,
mutation_path backfill). A pass that exhausts the budget yields and
resumes on a later tick from its durable watermark instead of running its
batch chain to completion. The budget must be enforced by wall-clock
measurement inside the pass loop, not by batch-count heuristics, so a
pathological cold-page batch cannot blow through it.

## Acceptance

- A shared budget seam covers retention shed, cold-history compaction,
  and mutation_path backfill; each pass checks it between bounded units
  of work.
- Deterministic in-process tests prove an oversized workload yields
  within the budget and resumes correctly from its watermark on the next
  tick (no lost or repeated work; re-fold determinism untouched — the
  budget gates producer-side passes only, never folds).
- A maintenance-only workload can no longer accumulate a lag-breach
  streak that reaches SERVE_LAG_MAX_CONSECUTIVE_BREACHES (asserted via
  the budget constant's relation to the lag threshold and interval, with
  a test pinning the arithmetic).

## Done summary
Added a shared 250ms wall-clock maintenance-budget seam (src/maintenance-budget.ts) consulted by retention shed, cold-row compaction, and mutation_path backfill; each pass yields between bounded transactions and resumes from its durable watermark on the next tick. Added tests proving oversized-workload yield/resume with no lost or repeated work, re-fold determinism untouched, and a test pinning the budget constant's arithmetic relation to SERVE_LAG_MAX_CONSECUTIVE_BREACHES.
## Evidence
