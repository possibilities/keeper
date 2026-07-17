## Description

**Size:** M
**Files:** test/slow/daemon-smoke.test.ts, test/helpers/daemon-smoke-harness.ts

### Approach

The two remaining ADR 0073 scenarios atop the task-1 harness. Worker-kill: with the sandboxed daemon steady, kill one of its real spawned workers and prove the supervision contract — main's fatal path or supervised respawn per the worker contract, bounded teardown of the dead worker's owned resources (locks, sockets, watcher subscriptions), and the restart ledger recording any daemon-level exit — using only observable evidence (ledger rows, socket state, process absence) under the parent deadline. Restart-verdict: run the actual restart CLI flow end-to-end against the sandboxed daemon with ONLY the launchctl seam injected (the sandbox has no LaunchAgent; the seam kills and respawns the sandboxed keeperd), proving the evidence verdict returns success on a healthy respawn and the honest failure on a daemon that never returns.

### Investigation targets

*Verify before relying.*

**Required** (read before coding):
- test/helpers/daemon-smoke-harness.ts — the task-1 harness this extends
- src/daemon.ts fatalExit + the restart ledger writer — the observable evidence the worker-kill scenario asserts
- cli/restart.ts runRestart deps seam — where the launchctl injection lands while everything else runs real

### Risks

- The worker-kill scenario must assert the CONTRACT (bounded teardown, ledger evidence), not incidental timing; keep assertions on durable observables.

## Acceptance

- [ ] Killing a real worker yields the contracted teardown and ledger evidence within the deadline
- [ ] The restart CLI returns a true success against a healthy sandboxed respawn and a true failure against a never-returning daemon
- [ ] Both scenarios run under the named gate with full sandbox teardown

## Done summary

## Evidence
