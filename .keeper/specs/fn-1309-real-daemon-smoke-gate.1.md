## Description

**Size:** M
**Files:** test/slow/daemon-smoke.test.ts, test/helpers/daemon-smoke-harness.ts, package.json, scripts/test-gate.ts

### Approach

The harness (ADR 0073): spawn a real keeperd subprocess with every state class sandboxed per-test via the existing `sandboxEnv` classes (own DB, sockets, ledgers, spools, config — never host state or the host daemon), own a hard wall-clock deadline that kills the entire subprocess tree on expiry so a hang is a bounded red, allow one disclosed retry, and tear down completely on every path. First scenario rides in the harness task: boot → wait for catch-up → assert the served frame/probe contract over the real socket — object-form frames carry `boot.catching_up` while catching up, steady-state memoized replies omit the header entirely, and `isCaughtUpFrame` agrees with both live shapes. Register the suite behind a new named gate (mirror the existing slow-git gate's phase shape in the gate runner); it never joins the correctness gates.

### Investigation targets

*Verify before relying — planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- test/helpers/ — the sandboxEnv builder and its full state-class list (CLAUDE.md test-isolation section names them)
- scripts/test-gate.ts + package.json test:slow-git — the phased gate shape to mirror for the new gate
- src/server-worker.ts stampBootStatus and the pre-serialized memo path — the two frame shapes the contract scenario pins
- cli/restart.ts isCaughtUpFrame — the consumer the contract scenario must agree with
- src/daemon.ts startDaemon flock gate — boot requirements a sandboxed spawn must satisfy

### Risks

- keeperd may assume host paths beyond the sandboxEnv classes; the early proof point is exactly whether a fully-sandboxed boot works — surface any un-sandboxable state as a BLOCKED design question rather than sandboxing partially.
- The deadline must kill the process TREE (daemon + workers), not just the leader.

### Test notes

The smoke asserts against the live wire, not fixtures; keep every wait on `retryUntil`-style polling under the parent deadline, never fixed sleeps.

## Acceptance

- [ ] A sandboxed keeperd boots and reaches caught-up with zero host-state writes
- [ ] Both live frame shapes are asserted and `isCaughtUpFrame` agrees with each
- [ ] A deliberately-hung scenario is killed at the deadline with full tree teardown and reads as red
- [ ] The new named gate runs the suite; correctness gates are unchanged

## Done summary

## Evidence
