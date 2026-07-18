## Description

Finding F1 (evidence: `cli/bus.ts` `renderMessageNotification`, verified at
commit 6c39c390). The live-Partner capture waits for the injected artifact
path to appear in the Partner's transcript (`findStopAfterInjectedMessage`),
but the receiver's notification renderer emits that path only when the line
`Agent Bus message from <sender> - read <resolved.path>` fits under
`NOTIFY_LINE_BUDGET` (400). Over budget it falls back to
`artifactFailureNotification`, which omits the path entirely, so the
boundary marker never lands and capture runs to `timed_out` with no answer
even though the message was delivered.

Files: `cli/bus.ts` (renderMessageNotification / boundary marker),
the live-capture boundary matcher (`findStopAfterInjectedMessage` /
`runLivePartnerCapture`) in the agent capture path.

Make the capture boundary robust to notification budgeting: either
guarantee the resolved artifact path survives budgeting (spill/truncate the
sender label, never the path) or key the boundary off a compact,
budget-immune artifact id rather than the full path. The failure fallback
must still carry whatever token the capture side matches on.

## Acceptance

- [ ] A delivered message with a very long resolved artifact path and/or a
      128-char sender still surfaces a boundary token the capture side
      matches, rather than falling back to a path-less line.
- [ ] Capture completes at the injected-message boundary (not `timed_out`)
      in that deep-root / long-sender case; existing default-config capture
      behavior is unchanged.
- [ ] Regression test covering the over-budget notification path for the
      capture boundary.

## Done summary

## Evidence
