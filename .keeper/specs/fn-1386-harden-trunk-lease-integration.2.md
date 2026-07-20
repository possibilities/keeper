## Description

Surviving audit finding F4, in `src/daemon.ts` `runTrunkLeaseSweep`.

`residueRecorded` (daemon.ts:4858) is allocated fresh each sweep, so the
active-lease loop (daemon.ts:4873-4881) calls
`recordResidue -> handleDispatchFailedMint` on every tick a lease's merge
leaves MERGE_HEAD present. That appends a synthetic `DispatchFailed` event
every `INCIDENT_CLAIM_SWEEP_INTERVAL_MS` (3s) for the entire duration a
live owner holds a conflicted merge — hundreds to thousands of no-op
events over a human-paced deconflict, permanently in the event log and
re-folded on every re-fold. `foldDispatchFailed`'s upsert preserves the
open incident (no distinct sticky-row spam) but the event churn stands,
against the CLAUDE.md "a history-growing fold cost is a re-fold time-bomb"
invariant.

Gate the mint on a residue-state transition: record only when residue
newly appears for a (repo_root, fencing_token), not on every tick it
persists. Use a durable/live-derived signal for the prior state rather
than the per-tick set, keeping the sweep producer-only and re-fold-safe.

Files: `src/daemon.ts`, `test/daemon.test.ts`.

## Acceptance

- [ ] runTrunkLeaseSweep mints a DispatchFailed event only on a residue-state transition (newly-appeared MERGE_HEAD), not once per tick it persists.
- [ ] A daemon.test.ts case asserts no repeat mint across successive ticks while residue persists unchanged.
- [ ] Named daemon gate green.

## Done summary

## Evidence
