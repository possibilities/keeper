## Description

**Size:** M
**Files:** src/daemon.ts, test/helpers/in-process-daemon.ts, test/integration.test.ts

### Approach

Build on fn-747's `startDaemon`/`DaemonOptions` (do NOT start until fn-747
lands — read the actual landed shape first; the field names below are the
intent, not a literal contract).

1. **Extend `DaemonOptions`** with a worker-set selector (e.g.
   `workers?: WorkerName[]`). In `runDaemon`'s 11-worker spawn block, gate
   each spawn on membership when a set is supplied; **default = the full
   set** so the production `import.meta.main → runDaemon` boot spawns the
   identical 11 workers. The production path passes no selector (or the
   full set) — zero behavior change there.
2. **Extend `withInProcessDaemon`** (test/helpers/in-process-daemon.ts) to
   accept and forward a worker set.
3. **Retrofit the migrated slow-tier tests** (from fn-747.1) to boot the
   minimal set each needs: UDS query/RPC/fold tests boot
   `events-ingest + reducer + server-worker` and spawn NO watcher worker
   (so the `@parcel/watcher` seam is irrelevant for them); only the
   plan-worker `.planctl` fold test boots the plan-worker.
4. **Re-soak** 20x: 0 fails, and note the wall-time drop vs full-boot
   (informational).

### Investigation targets

**Required** (read before coding):
- src/daemon.ts:1290 — the landed `startDaemon` / `DaemonOptions` / `DaemonHandle` from fn-747.2 (read the real shape first)
- src/daemon.ts:1246 — `runDaemon`'s 11-worker spawn block the selector gates
- test/helpers/in-process-daemon.ts — the fn-747 harness to extend
- test/integration.test.ts — the migrated tests (fn-747.1) to retrofit to minimal boot sets

**Optional** (reference as needed):
- scripts/soak-slow-tests.ts — the re-soak harness
- CLAUDE.md — Worker contract, Supervisor-owned lifecycle

### Risks

- **Production-boot regression is the headline risk.** The selector default
  MUST be all-workers; a wrong default silently drops a worker in prod
  (e.g. no autopilot, no exit-watcher). Assert the prod boot spawns the
  identical 11 in a test.
- **Inter-worker dependencies.** A partial set must still satisfy each
  test's assertions — a fold query needs the reducer to have folded and the
  server-worker to serve it. Pick each test's worker set deliberately, not
  minimally-by-guess.
- Hard-blocked on fn-747; the option shape is not final until fn-747.2 lands.

### Test notes

- Re-run the 20x soak; expect 0 fails and a wall-time drop vs the
  full-boot baseline (informational only — soak gates on pass/fail).
  Confirm `bun run test` umbrella green. Add a regression test asserting
  the default/production boot still spawns the full worker set.

## Acceptance

- [ ] `DaemonOptions` carries a worker-set selector; `startDaemon` spawns only the selected workers; default = full set; a test asserts the production boot spawns the identical 11 workers
- [ ] `withInProcessDaemon` accepts + forwards a worker set
- [ ] Migrated UDS query/RPC/fold tests boot only events-ingest + reducer + server-worker (no watcher worker); the plan-worker fold test boots the plan-worker
- [ ] A ≥20x parallel soak completes with 0 failures; `bun run test` umbrella green

## Done summary
Added DaemonOptions.workers selector to startDaemon (default = full 11-worker set, so production runDaemon is byte-for-byte unchanged); withInProcessDaemon forwards it; migrated UDS/RPC/fold tests boot only wake+server and the plan-fold test adds plan; added regression tests asserting the prod boot spawns the identical 11 and a minimal set spawns only the named workers.
## Evidence
