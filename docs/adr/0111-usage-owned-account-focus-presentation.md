# 111. Usage-owned Account-focus presentation

## Status

Accepted. Supersedes ADR 0104 while preserving latest-frame human viewers, one-pane tmux windows, deterministic Summary presentation, bounded machine frame streams, and the separation between human viewers and machine interfaces. Changes only the human owner of Account-focus presentation.

## Context

The Board's semantic header combines Account-focus state, Board counts, and Autopilot intent above the plan rows. Those focus sections consume scarce vertical space in the plan viewer while describing the same Claude Capacity domain operators inspect in Usage.

Summary separates stable Board and Autopilot overview from plan rows, but making it the sole human focus owner splits related quota and routing intent across two windows. Account focus is meaningful beside the target route's current meters, eligibility, and reset horizon. Machine consumers already use account inspection and status rather than human-view output.

## Decision

The dedicated `tmux -L dash` server hosts the named one-pane human viewers `jobs`, `autopilot`, `board`, `summary`, `git`, and `usage`. Each viewer remains live, read-only, latest-frame-only, and free of application-owned navigation state.

Board renders plan rows without an Account-focus, count, or Autopilot semantic header. Summary owns deterministic human presentation of Board counts, needs-human state, and Autopilot intent and health. It does not duplicate Account-focus detail.

Usage owns human Capacity and Account-focus presentation. Its existing Claude and Codex capacity blocks remain first; full `Fable focus` and `Non-Fable focus` sections follow as one related closing chapter. Off scopes collapse to one line. Configured or unavailable scopes retain target route, lifetime, current eligibility, effective routing state, and bounded delivery diagnostic. Focus changes participate in Usage's semantic-change fingerprint, while relative deadline prose repaints locally with the rest of the time-sensitive Usage view.

One Usage snapshot derives provider meters and both focus views from one coherent Capacity observation and one read of each independent owner-only focus leaf. The views retain their separate policy identities and failure domains. Missing custom focus paths omit the focus chapter rather than reading host state.

`keeper usage --json` remains the capacity-only schema-v1 machine contract. Machine consumers read focus state through account inspection, account checks, or `keeper status --json`; human viewer sidecars and rendered output remain non-contractual. Usage remains excluded from `keeper frames` because Capacity sidecars carry no daemon Fold cursor.

Jobs always presents backend pane, monitor, subagent, and scheduled-task detail. Jobs, Autopilot, Git, and Summary keep deterministic terminal-safe YAML presentation with fixed semantic field order and stable total ordering. Reconnect, readiness, stale-frame behavior, current-state sidecars, and local Usage repaint behavior remain shared shell concerns.

`keeper frames` remains the sole agent-facing rendered-frame interface. Its versioned NDJSON envelopes, bounds, cursor, coverage, exit behavior, and bounded sidecar ring remain independent from human-view retention. Human and agent instructions continue to prefer machine queries over viewer output.

## Alternatives considered

- **Keep focus on Board.** Rejected because quota-routing intent competes with plan rows and has a stronger Capacity-domain home.
- **Make Summary the sole focus owner.** Rejected because it separates target intent from the meters and reset horizons that explain whether the focus is useful.
- **Render focus in both Summary and Usage.** Rejected because two human owners invite presentation drift and spend vertical space twice.
- **Add focus fields to `keeper usage --json`.** Rejected because account inspection and status already own the machine contract, while Usage JSON remains a narrow normalized-capacity envelope.
- **Read focus independently from the Capacity sample.** Rejected because one rendered snapshot could mix quota and eligibility from different observation generations.

## Consequences

Operators inspect quota and its routing preference in one Usage window, while Board and Summary become less dense and more question-specific. Focus delivery faults remain visible without widening the Usage machine schema. Summary work must omit Account-focus fields and fixtures, and operator documentation must direct human focus inspection to Usage while preserving account inspection and status as the machine-readable paths.
