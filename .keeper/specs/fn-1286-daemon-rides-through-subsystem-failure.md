## Overview

A production incident crash-looped keeperd every ~95-121s for two hours: a duplicate-watcher takeover storm saturated the Agent Bus accept loop, the serve-liveness watchdog fatalExited the whole daemon on `accept-stall-bus` while the READ server was green, and every restart re-fed the storm. Collateral: restart-orphaned agent processes (zombie sessions) wedged done-stamped tasks at `running:sub-agent-stale` until a human hand-killed them, and the operator page path silently swallowed its spawn failure (`botctl` absent) so nobody was ever paged. This epic makes the daemon ride through non-critical subsystem failure: bus-only stalls degrade in place (ADR 0059), duplicate live bus subscribers are rejected instead of eviction-warring (ADR 0061), proven-finished zombie sessions are reaped and ambiguous ones paged (ADR 0060), and paging failure is itself fail-visible.

## Quick commands

- `bun test test/daemon.test.ts test/bus-worker.test.ts test/autopilot-worker.test.ts test/tmux-control-worker.test.ts` — the touched truth-table suites
- `bun run test:gate` — the named deterministic gate (fn-1281 contract; new test files must be discovered by it)
- `sqlite3 -readonly ~/.local/state/keeper/keeper.db "select verb,id,reason from dispatch_failures"` — observe the new distress surfaces live

## Acceptance

- [ ] A bus-only accept stall never exits the daemon: the watchdog degrades the bus with a paging, level-cleared distress row while the READ path keeps serving; a READ-server stall still fatalExits.
- [ ] A second live `keeper bus watch` under an existing (pid,start_time) identity is rejected with a typed error; a dead predecessor is still taken over; an eviction war can no longer occur.
- [ ] A stopped job with a done-stamped task, a live pid, and no activity past grace is reaped (TERM then KILL, identity re-checked before each signal) and the board completes without human intervention; every ambiguous state is paged, never killed.
- [ ] A failed operator-page spawn is itself visible (meta-distress on a missing pager binary) and never stamps `human_notified_at`.

## Early proof point

Task that proves the approach: ordinal 2 (watchdog bus-degrade) — the reducer's `degrade` verdict variant plus its truth-table rows. If the degrade branch cannot be expressed cleanly in the reducer, fall back to a consumer-side trigger check keyed on `accept-stall-bus`.

## References

- docs/adr/0059-bus-only-serve-stall-degrades-in-place.md (bus degrade decision + internal-wedge tradeoff)
- docs/adr/0060-zombie-session-hybrid-reaper.md (kill/page boundary, identity re-check, readiness escape valve)
- docs/adr/0061-bus-takeover-only-over-dead-predecessor.md (duplicate_subscriber rejection, client backoff)
- docs/adr/0003-fatal-exit-over-self-heal.md (the doctrine being carved; carve-outs stay explicit and bounded)
- `fn-1281-radical-deterministic-test-gate` (dependency): new test files must register with the named test:gate manifest — the gate fails closed on undiscovered suites — and must be pure-seam (no real tmux/daemon/UDS/subprocess/sleep).
- `fn-1282-retire-hermes-codex-harnesses` (overlap): deletes large regions of src/daemon.ts (codex imports/sweeps); this epic edits the watchdog region of the same file — sequenced via epic dep to avoid fan-in conflicts.
- `fn-1283-prune-stale-monitor-slot-backstop` (overlap): rewrites the provenDeadJobIds doc-comment inside the exact reconcile-snapshot region the zombie reaper extends.

## Docs gaps

- **CLAUDE.md**: serve-liveness line overstates when the daemon dies (fatalExit now scoped; bus degrades) — task 2 carries the one-line correction; "the four reapers" count changes — task 5 carries it. Prune-not-append; keep `bun scripts/lint-claude-md.ts` green.
- **docs/problem-codes.md**: add rows for the bus-degrade distress code (task 2) and the paging-channel-down meta-distress (task 1).

## Best practices

- **Liveness vs readiness split:** the supervisor heartbeat means "critical control path progressing," not "everything perfect" — restart only on global-fatal; degrade + surface the rest. [systemd watchdog design, Google SRE]
- **PID-reuse safety:** re-verify (pid, OS start_time) immediately before EACH signal, never trust a recorded pid; SIGTERM → grace → SIGKILL so the harness can flush and fire stop hooks. [LWN race-free signaling]
- **Retry-storm damping:** jitter plus a minimum-session-duration before backoff reset — reset-on-every-clean-session keeps a fast evict loop in 250ms lockstep. [Azure retry-storm antipattern]
- **Alert on the alerter:** a swallowed page-spawn failure is indistinguishable from "no incident" — the paging channel going down must mint its own distinct in-band signal. [Google SRE Workbook]
