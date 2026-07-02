## Overview

Twice today the daemon's UDS serve layer went dark while every worker thread stayed healthy —
status reads timed out, the board hung connecting, bus registry reads timed out while sends
delivered — recoverable only by kickstart. The wedge signature matches known Bun UDS issues
(accept-loop stall under concurrent load being the closest). Two deliverables, deliberately
decoupled: a serve-liveness watchdog that detects the wedge and fatalExits into the
LaunchAgent restart (ships regardless of root cause), then a debug-skill-method investigation
that uses the watchdog's telemetry (gated on it, since both touch the same serve files).

## Quick commands

- Simulated serve stall (SIGSTOP the serve path in a scratch daemon): watchdog escalates within its window and the LaunchAgent restarts
- `keeper status --json` under wedge: operator sees a restart, not a permanent hang

## Acceptance

- [ ] A wedged serve path (either socket) is detected within a bounded window and the daemon fatalExits; healthy-but-busy does not false-positive
- [ ] The probe exercises a real registry-read on each socket, not connect-only (the observed wedge kept sends alive while reads died)
- [ ] Root cause found and fixed, or a bounded finding doc naming the wedge class, repro attempts, and upstream issue linkage; the boot-sweep "file is not a database" rider is identified
- [ ] CLAUDE.md no-self-heal carve-out gains the watchdog sentence (minimal delta, lint green)

## Early proof point

Task that proves the approach: `.1` (watchdog) — the pure verdict function with clock/probe
inputs is testable in the fast tier on day one. If the in-daemon probe cannot observe its own
serve wedge reliably, escalate the design to a probe from an existing worker thread (still
in-process, still fatalExit).

## References

- src/daemon.ts:1341 decideGitSeedWatchdog — the pure-verdict watchdog pattern to copy (30s cadence, ok|escalate, escalate→fatalExit)
- src/server-worker.ts (keeperd.sock) + src/bus-worker.ts (bus.sock; fatalExit reserved for boot at :19 — the watchdog changes that contract deliberately for the serve-wedge verdict)
- src/plan-worker.ts:3518-3520 — the boot-sweep catch where "file is not a database" surfaces
- Wedge candidates (verified open Bun issues): #8044 UDS accept-loop stall under concurrency; silent socket.write drop past kernel send buffer; #32469 ReadableStream backpressure; #29166 stale socket file (unlink-at-boot mitigation)
- Evidence: CPU sample /tmp/keeperd-spin.sample.txt; inventory item 17 (two incarnations; bus.db-wal writes stopped ~1h before detection; bus list dead while chat send delivered)
- Watchdog thresholds (verified practice): monitorEventLoopDelay p99 over ~800-1000ms for 3+ consecutive intervals = wedged-busy; the accept-stall mode shows LOW lag — the heartbeat probe with a hard timeout is the detector for that mode; exit non-zero always

## Docs gaps

- **CLAUDE.md**: the "No in-process self-heal" carve-out list gains the serve-liveness watchdog (one sentence, mirroring the git seed-liveness precedent)
- **plugins/keeper/skills/await/SKILL.md**: server-up prose only if reachability semantics change
- **docs/plugin-composition-map.md**: note the probe if it lands monitor-shaped

## Best practices

- **Two detectors for two modes:** lag histogram catches busy-wedge; a real-query heartbeat with hard timeout catches accept-stall (low lag, zero throughput)
- **fatalExit directly from the verdict** — never signal-to-self, never exit 0 (LaunchAgent may suppress restart on clean exit)
- **Unlink the socket path at boot** before serving (SIGKILL leaves stale files)
