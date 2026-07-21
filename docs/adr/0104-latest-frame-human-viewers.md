# 104. Latest-frame human viewers and machine frame streams

## Status

Accepted. Provisional number — fan-in renumbering per ADR 0020/0022. Supersedes
ADR 0097's human-view history clause and ADR 0100's Board-owned Account-focus
presentation while preserving their data and provenance boundaries.

## Context

Keeper exposes two different observation surfaces. Operators keep live terminal
views open on the dedicated tmux server, while agents need bounded, resumable
evidence about rendered changes. Treating the human viewers as an agent interface
couples automation to TTY mode, snapshot trailers, application keys, and
per-process temporary files. Retaining every accepted human frame in memory and
as indexed state, text, and diff sidecars also turns a current-state display into
an unbounded archive.

The Board combines plan rows with a large semantic header covering Account focus,
Board counts, and Autopilot intent and health. That header competes with the plan
rows in a shared pane. Jobs additionally hides operational detail behind
application-owned expansion state. A multi-pane tmux window constrains every
surface even though each answers a separate operator question.

## Decision

The dedicated `tmux -L dash` server hosts six named one-pane windows running the
human viewers `jobs`, `autopilot`, `board`, `summary`, `git`, and `usage`. Setup
rebuilds the dedicated server through its existing identity, recovery, and
self-teardown safety rails and initially selects Board. The separate interactive
`keeper dash` job-card application remains independent.

Each human viewer is live and read-only, retains only its latest accepted frame,
and has no application state transitions except scrolling. Ctrl-C remains process
teardown; tmux continues to own window switching and copy mode. Human viewers do
not expose an append-only `--watch` mode. Their temporary evidence is one atomic
per-process current state/frame pair rather than numbered state/frame/diff files,
a previous-frame scratch file, or an append-only frame index. Reconnect,
readiness, and stale-frame behavior remains shared shell chrome, and local Usage
repaints update its current evidence.

Jobs always presents backend pane, monitor, subagent, and scheduled-task detail;
there is no expansion, selection, replay, or pane-focus mode. Jobs, Autopilot,
Git, and Summary build deterministic, terminal-safe presentation models and
serialize them as human-oriented YAML with fixed semantic field order, stable
total ordering, no aliases or width-dependent wrapping, and complete lists.
Board retains its plan-row renderer without the semantic header. Usage retains
its specialized capacity-meter renderer.

Summary becomes the sole human owner of the former Board semantic header:
Account-focus desired and effective state, Board counts, and Autopilot intent and
health. It represents time with structured UTC values and explicit states rather
than locale-, width-, or relative-time-dependent prose. Its first paint waits for
a coherent composite in live, snapshot, and machine-frame modes; seeded partials
never present as current state.

`keeper frames` remains the sole agent-facing rendered-frame interface. Its
versioned NDJSON envelopes, bounds, cursor and coverage semantics, exit behavior,
and bounded sidecar ring remain independent from human-view retention. Summary
joins its view set additively; Usage remains excluded because Capacity sidecars
carry no daemon Fold cursor. Agent instructions and operator automation use
machine queries such as `keeper status`, `keeper query`, and `keeper frames`,
never human viewer commands, snapshots, or sidecars.

## Consequences

- Operators get one full tmux window per question and can inspect complete current
  lists by scrolling without browsing prior frames.
- Human-view rendering and persistence no longer form an accidental automation
  contract; removing `--watch` leaves one bounded path for agent frame evidence.
- Deterministic presentation models make YAML stable enough for exact tests while
  remaining free to evolve as a human format rather than a versioned machine API.
- Board and Summary must share canonical projections so counts, needs-human
  classification, Account-focus state, and Autopilot state cannot drift.
- Viewer help, prompts, skills, and docs must keep the human/machine boundary
  explicit, and the Frames API must preserve its independent compatibility tests.
