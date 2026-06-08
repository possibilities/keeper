## Overview

fn-747 lands `startDaemon(opts) → DaemonHandle` and migrates the slow-tier
tests onto a full in-process daemon (all 11 workers) with a
`@parcel/watcher` seam. That removes the per-test subprocess and the native
SIGTRAP, but every converted test STILL boots the whole daemon — autopilot,
git/transcript/usage/dead-letter workers, exit-watcher — none of which most
of those tests exercise. This epic tightens that: extend `DaemonOptions`
with a worker-set selector so `startDaemon({ workers: [...] })` spawns ONLY
the workers a test needs (default = the full set; the production
`runDaemon` boot is byte-for-byte unchanged). A UDS query/RPC/fold test then
boots just events-ingest + reducer + server-worker and spawns NO watcher
worker at all — so the `@parcel/watcher` problem disappears for it rather
than being worked around. Re-soak to confirm 0 flakes and a wall-time drop.

Hard-blocked on fn-747: this builds on the `startDaemon`/`DaemonOptions`
shape and the migrated tests fn-747 introduces, so it can't start until
fn-747 lands and the real options object is visible.

## Quick commands

- `bun run test:slow` — slow tier, now minimal-boot per test
- `bun scripts/soak-slow-tests.ts 20` — re-soak 20x; expect 0 fails, faster wall time
- `bun run test` — full umbrella, green

## Acceptance

- [ ] `DaemonOptions` carries a worker-set selector; `startDaemon` spawns only the selected workers; default = the full set; production `runDaemon` boot spawns the identical 11 workers (zero regression)
- [ ] The `withInProcessDaemon` harness accepts a worker set
- [ ] Migrated slow-tier tests boot only the workers they exercise (UDS query/RPC/fold tests spawn no watcher worker)
- [ ] A ≥20x parallel soak completes with 0 failures; `bun run test` umbrella green

## Early proof point

Task that proves the approach: `.1`. The risky premise is that a partial
worker set still satisfies each test's assertions (inter-worker
dependencies — a fold query needs the reducer + server, a plan-worker fold
needs the plan-worker). If a minimal set proves too fragile to maintain:
fall back to fn-747's full-boot-with-seam (this epic is purely an
optimization on top — fn-747 already ships a working parallel-safe tier).

## References

- **Hard dep: fn-747-parallelize-slow-test-tier-soak-harness** — provides
  `startDaemon(opts: DaemonOptions): DaemonHandle` (`src/daemon.ts:1290`),
  the `@parcel/watcher` seam, the `test/helpers/in-process-daemon.ts`
  harness, and the migrated slow-tier tests this epic tightens. Read the
  LANDED `startDaemon`/`DaemonOptions` shape before decomposing — it is
  in_progress as of this epic's creation, so the exact option fields are not
  yet final.
- `src/daemon.ts:1246` `runDaemon` — the 11-worker spawn block the selector
  must gate without changing the production default-all behavior.
- **Overlap (advisory, NOT wired):** `fn-744-board-serve-and-fold-latency-under-load`
  edits `src/server-worker.ts` startup + `package.json` test scripts; if
  this epic's selector touches server-worker boot wiring, coordinate.

## Docs gaps

- **CLAUDE.md** (Worker contract / Test isolation): if a worker-set selector
  becomes part of the daemon boot contract, note that the default is the
  full set and production never passes a subset.
