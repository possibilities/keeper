## Description

**Size:** M
**Files:** src/view-shell.ts, test/view-shell.test.ts, docs/adr/0019-tui-readiness-gate-over-boot-status.md, CONTEXT.md

### Approach

Render the reconnect truth the client already emits. Three banner states
with a fixed transition table: grace (hold-last-frame + the existing
reconnecting pill, unchanged), retrying (after the grace: attempt N and a
retry-in countdown driven from the waiting payload's attempt/retry_in_ms —
today that payload reaches only the lifecycle sidecar), and long-dead (the
DISCONNECTED token plus last-good-frame age from a NEW monotonic per-frame
stamp, shown once age exceeds a small threshold, ticking on the existing
spinner cadence, gated on frame recency never socket state). Banner text
stays plain (never SGR-parsed); color signals stay in the body indicator.
The countdown resets when data resumes (exitReconnecting on paint). A silent
generation re-baseline with no transport drop surfaces nothing. Degrade in
place — never blank the panel. Revise ADR 0019's Decision/Consequences in
place to the new model (one slice, no stale second paragraph). Add CONTEXT.md
terms only if the new states earn first-class names; DISCONNECTED remains the
sole dead-socket token and "reconnect" is never used in the resume sense.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/view-shell.ts:620-895 — the banner state machine (grace arm, pill, DISCONNECTED token, formatIndicatorLine); :1231-1273 emitLifecycle (route the waiting branch to state, keep the sidecar write); :1202 paintLiveFrame ordering
- src/dash/app.ts:782-798 — the other onLifecycle consumer that must keep working

**Optional** (reference as needed):
- test/view-shell.test.ts — injected-lifecycle-event test idioms

### Risks

- Wall-clock frame age lies across suspend/resume — the stamp must be monotonic
- The banner is shared by five panes and the dash; a render regression is universally visible

### Test notes

Drive injected lifecycle events: grace shows the pill; waiting after grace
shows attempt/countdown; long-dead shows DISCONNECTED + age advancing on the
fake clock; paint clears everything; a generation re-baseline without a drop
renders nothing.

## Acceptance

- [ ] The three banner states render per the transition table from injected lifecycle events, countdown and age driven by the fake clock
- [ ] Frame age uses a monotonic stamp gated on frame recency and the panel degrades in place, never blanking
- [ ] ADR 0019 describes the new model in place with no stale remainder
- [ ] The view-shell test gate passes

## Done summary
Rendered the three-state reconnect banner (grace, retrying with attempt/countdown, DISCONNECTED with monotonic last-good-frame age) driven from existing lifecycle telemetry; degrades in place, never blanks the panel. Revised ADR 0019 in place to the new model.
## Evidence
