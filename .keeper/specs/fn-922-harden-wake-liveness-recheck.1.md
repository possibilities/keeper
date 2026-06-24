## Description

Finding F1 (audit of fn-918, evidence `src/bus-wake.ts:124`): the wake's
spawn-time liveness recheck `creatorIsLive` ORs `liveSessionIds.has(job_id)`
with `isRunningState(job.state)`, and `isRunningState` returns true ONLY for
`state === "working"`. A creator that is `stopped` but still has a live tmux
pane — and has not re-armed `keeper bus watch` (so it is absent from
`liveSessionIds`) — reads as "not live" and gets a redundant `claude --resume`
double-attach, the precise hazard the recheck guards against. The autopilot's
`isStoppedJobLive` (`src/autopilot-worker.ts:822`) already treats a
`stopped` job with a live pane as live by checking `backend_exec_pane_id`
membership in a live-pane set. Widen the wake liveness signal to include a
live-pane probe parallel to `isStoppedJobLive` (inject the live-pane set as a
`WakeDeps` seam so the decision stays pure and unit-testable), so a
`stopped`+live-pane creator is treated as live and SKIPped. Keep the existing
"on doubt, treat as live and SKIP" disposition. Close the matching Test Gap:
`test/bus-wake.test.ts` currently covers only `working` / on-bus / offline+stopped,
not the `stopped`+live-pane case.

## Acceptance

- [ ] `creatorIsLive` (or its successor) returns true for a `stopped` creator whose pane is in the injected live-pane set, even when absent from `liveSessionIds`.
- [ ] A `stopped` creator with no live pane and not on the bus still wakes (no regression on the genuine-offline path).
- [ ] The live-pane signal is injected as a pure `WakeDeps` seam; no real tmux probe in the decision function.
- [ ] `test/bus-wake.test.ts` adds a `stopped`+live-pane case (synthetic inputs, no real tmux).

## Done summary

## Evidence
