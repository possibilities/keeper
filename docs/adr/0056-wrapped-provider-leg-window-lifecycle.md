# 56. Wrapped provider-leg window lifecycle

## Status

Accepted. Builds on [ADR 0050](0050-wrapped-delegation-guard.md) (the dumb-courier
wrapper contract), [ADR 0051](0051-panel-run-ownership-and-task-cancellation.md)
(exact run-owned teardown), and
[ADR 0055](0055-harness-activity-dispatch-claims-and-resource-holds.md) (Harness
activity and Resource hold separation).

## Context

A wrapped cell's claude wrapper launches its provider leg through `keeper agent
run`. The provider legs share one `wrapped` Tmux session, but each launch leaves
its window resident after the Harness turn stops because the generic agent
launcher preserves stopped conversations for inspection and resume. The daemon's
autoclose worker admits only positively owned autopilot, panel, and escalation
windows, so stopped provider-leg windows accumulate even though their wrapper can
continue the Harness session from its persisted resume target in a fresh window.

The shared session and the provider-leg title currently repeat the same namespace:
`wrapped` contains windows titled `wrapped::<task-id>`. Resume launches also drop
an explicitly supplied Tmux session and title, allowing later turns of the same
provider leg to escape the shared topology. Adding the generic
`--reap-window-on-terminal` posture is unsafe: a chunk-level `timed_out` result
means the provider is still working, while that posture tears down the launched
window whenever capture returns.

## Decision

The `wrapped` Tmux session is the explicit lifecycle boundary for provider-leg
windows. For durable owned legs, ADR 0071's leg cascade is the sole teardown
authority: it targets birth-captured pane and generation coordinates after an
exact live-topology check, never a task title. It also converges an owned
idle-stopped window while the owner remains live. A wrapper change preserves
ownership only through the fenced transfer transition.

The autoclose worker's wrapped bucket remains only for the pre-ownership,
ownerless cohort. It admits stopped, live-topology-resolved jobs born in the
`wrapped` session whose title matches a Provider-leg task id and for which no
`provider_leg_ownership` row exists. The existing grace, exact pane identity,
generation checks, prompt rails, blast cap, config off-switch, and autopilot
pause apply unchanged. The bucket recognizes the prefixed title form so legacy
windows converge without a migration. A display-only status gauge tracks this
cohort until it reaches zero; it is not a needs-human signal or Operator jam.

Provider-leg titles are bare task ids inside `wrapped`. The title remains display
metadata and a convenience lookup, never teardown or Harness identity. Waiting
and cleanup use the run handle and exact tmux identity; continuation uses the
Harness resume target. Duplicate display titles therefore cannot authorize a
kill or bind one attempt to another.

An explicit session or name supplied to `keeper agent run --resume` is launch
presentation, not resumed model configuration, and is carried into the new
window. The wrapped-worker contract supplies `--session wrapped --name
<task-id>` on every fresh and resumed turn. Removing the last provider window may
remove the Tmux session; the existing race-safe shared-session launch path
recreates it on demand.

## Consequences

- Owned Provider-leg windows converge through the durable leg cascade; the
  autoclose path serves only the draining ownerless cohort.
- Running provider legs and chunk-level timeouts remain untouched; autoclose
  continues to require positive stopped state.
- Manual callers that deliberately launch a task-shaped window into `wrapped`
  opt into the same autoclose lifecycle.
- Generic pair, debug, handoff, and resident agent runs keep their existing
  stay-open behavior.
- Resume preserves the shared topology without treating a Session title as a
  Harness resume key.
- Existing prefixed windows are cleanup-compatible, while new windows present
  only the task id.
