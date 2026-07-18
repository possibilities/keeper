## Description

Finding F1 (with merged test-gap F2). Evidence path: `cli/status.ts:432-433`
— the `atRest` predicate reads `inFlightTotal === 0 && epicTally.ready === 0
&& epicTally.running === 0`, but `tallyVerdicts` (cli/status.ts:367-372) now
partitions stale-running rows into `stale_running` instead of `running`. So a
board whose only occupancy is stale-running epics computes
`epicTally.running === 0` and flips `atRest`/`drained` true. Fix: extend the
predicate to also require `epicTally.stale_running === 0`. Add the F2 test in
`test/status.test.ts` asserting `drained: false` / correct `jammed` for a
board whose only occupancy is stale-running epics.

Files: cli/status.ts, test/status.test.ts

## Acceptance

- [ ] `atRest` includes `epicTally.stale_running === 0` in its predicate
- [ ] Board with only stale-running epics + no needs-human reports `drained: false`
- [ ] `test/status.test.ts` pins the atRest/drained/jammed x stale_running interaction

## Done summary
atRest now requires epicTally.stale_running === 0, so a board whose only occupancy is stale-running epics reports drained: false. Pinned with a new test in test/status.test.ts.
## Evidence
