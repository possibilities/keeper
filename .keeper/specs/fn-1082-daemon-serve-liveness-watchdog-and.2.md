## Description

**Size:** M
**Files:** src/server-worker.ts, src/bus-worker.ts, src/plan-worker.ts (finding-dependent), ~/docs/serve-wedge-finding.md (+ yaml sidecar)

### Approach

Debug-skill method, strictly: no hypothesis before a red-capable reproduction loop exists.
Phase 1 — build the loop: a scratch daemon (manual script, NOT the fast test tier) under
synthetic concurrent UDS load (the #8044 signature: many parallel clients against
Bun.serve/unix or the raw socket server, whichever shape the serve workers use — read them
first); instrument with the task-.1 watchdog telemetry. If the wedge reproduces: bisect the
trigger (connection rate, payload size, backpressure, dead-peer reaps racing accepts),
identify the wedge class against the four verified Bun issue candidates, fix what is fixable
in keeper's serve code (bounded accepts, Response-pattern writes, no streaming bodies) and
link upstream for what is not. If it does not reproduce within a bounded effort: write the
finding doc (repro attempts, ruled-out classes, the watchdog as the standing mitigation) —
"cannot build a loop" is a documented stop, not a license to guess. Separately and
cheaply: chase the boot-sweep "file is not a database" rider from the plan-worker catch —
identify WHICH file the sweep opened (both main DBs pass integrity checks) and fix or file.

### Investigation targets

**Required** (read before coding):
- src/server-worker.ts + src/bus-worker.ts — the actual serve implementation shape (Bun.serve unix vs raw listener), write paths, backpressure handling
- /tmp/keeperd-spin.sample.txt — the captured wedge sample
- src/plan-worker.ts:3518-3520 — the sweep catch; enumerate what paths scanner.sweep opens
- ~/.local/state/keeper/server.stderr around the two wedge windows — dead-peer reap patterns during the stall

### Risks

- Open-ended by nature — the bounded-effort stop with a finding doc is a legitimate completion; do not spin past the budget.
- Repro experiments must never target the production daemon or its live sockets — scratch state dirs only (sandboxEnv-style isolation).

### Test notes

Any code fix carries a fast-tier test of the pure decision it changes; the repro script
lands under scripts/ as a manual tool, not in the test suites.

## Acceptance

- [ ] Red-capable repro loop built and wedge class identified with a fix or upstream linkage, OR a bounded finding doc with repro attempts and ruled-out classes
- [ ] The "file is not a database" source identified and fixed or filed
- [ ] Any serve-code fix keeps both suites green; repro tooling isolated from production state

## Done summary
Bounded-effort finding. Built scripts/repro-serve-wedge.ts (red-capable Bun.listen UDS accept-stall repro with a real-read probe detector); the wedge (Bun #8044 low-lag accept-stall, confirmed by the parked-kevent64 CPU sample) did not reproduce under aggressive load on Bun 1.3.14, so ~/docs/2026-07-02-fn-1082-2-serve-wedge-finding.md documents the wedge class, repro attempts, ruled-out classes, and upstream linkage, with task .1's watchdog as the standing mitigation. The 'file is not a database' rider is identified+filed: a rare boot-correlated keeper.db reader-NOTADB across all PRAGMA data_version pollers (exit-watcher/git-worker/plan-worker), NOT a sweep-opened stray file; the sweep already tolerates it.
## Evidence
