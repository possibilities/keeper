## Description

**Size:** M
**Files:** plugins/keeper/pi-extension/monitor-facade.ts, test/pi-monitor-facade.test.ts

### Approach

Build an isolated, dependency-free command-monitor controller and tool-definition seam for tracked Pi. Mirror the live Claude command contract exactly over `command`, `description`, `persistent`, and `timeout_ms`: `persistent` defaults false; the deadline defaults to 300000 ms, accepts 1000–3600000 ms, and is ignored for persistent watches. The current Claude `ws` source variant is deliberately outside this command-only epic and must not leak into the public Pi schema.

A successful arm returns a stable task id immediately after the shell child and listeners are installed. Run the command in the session cwd and environment with Bash-compatible shell semantics; continuously persist stdout and stderr to a private bounded-path artifact, but emit events only from complete stdout lines. Batch lines arriving within 200 ms, bound line and queue growth, suppress a noisy stream only within a fixed budget, then auto-stop visibly rather than letting one watch monopolize turns. A normal exit, spawn failure, timeout, explicit task stop, and session shutdown each have one terminal state.

The controller owns a stable sorted `list()` snapshot, exact-id `stop()`, and idempotent `stopAll()`. Timeout, stop, and shutdown converge through generation-fenced, bounded TERM-then-KILL process-tree teardown; no automatic child restart belongs to the Monitor contract. Expose injection seams for spawning, clocks/timers, task-id allocation, artifact I/O, and event/terminal delivery so correctness tests remain process-free.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `plugins/keeper/pi-extension/task-facade.ts:794` — strict shared-tool facade construction and fail-open registration precedent.
- `plugins/keeper/pi-extension/bus-inbox.ts:90` — isolated child spawn shape and extension import boundary.
- `plugins/keeper/pi-extension/bus-inbox.ts:118` — generation-fenced delivery and bounded record framing.
- `plugins/keeper/pi-extension/bus-inbox.ts:226` — idempotent session teardown and TERM/KILL ladder.

**Optional** (reference as needed):
- `test/pi-bus-inbox.test.ts:53` — fake-child lifecycle, stale-output, timeout, and teardown test patterns.
- `test/pi-task-facade.test.ts:250` — strict facade schema and tracked-session registration fixtures.

### Risks

Shell commands are deliberately privileged like Bash; never interpolate a second configuration language or widen the inherited environment. Child exit, timeout, and explicit stop race each other, so exactly one terminal event may win and every later callback must no-op. A newline-free or flooding child must not grow memory or context without bound.

### Test notes

Use fake children, timers, artifact writers, and delivery callbacks. Pin schema strictness/defaults, immediate id return, CRLF and split UTF-8 framing, no partial-line event, 200 ms batching, bounded flood auto-stop, stderr-only persistence, every terminal race, exact-id list/stop, and shutdown during timeout or teardown.

## Acceptance

- [ ] The command-mode Monitor schema rejects unknown fields and unsupported source variants while honoring the shared persistent and timeout defaults/caps.
- [ ] A successful arm returns one stable task id immediately and records a live, stably ordered monitor snapshot before any event can be delivered.
- [ ] Complete stdout lines are durably captured and delivered in bounded batches; stderr and final partial lines never become monitor events, and a sustained flood visibly auto-stops.
- [ ] Normal exit, spawn failure, timeout, exact-id stop, and stop-all each produce at most one terminal outcome and leave no child, timer, listener, or ownership residue.
- [ ] The focused monitor-runtime suite passes without starting a real subprocess.

## Done summary

## Evidence
