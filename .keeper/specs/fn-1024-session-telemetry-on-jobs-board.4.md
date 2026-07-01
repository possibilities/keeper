## Description

**Size:** M
**Files:** src/statusline-worker.ts (new), src/daemon.ts, src/db.ts, test/statusline-worker.test.ts (new)

The file-watch producer that turns leaf-file changes into coalesced `SessionTelemetry` events
minted on main — copying the `usage-worker` archetype, with the behaviors telemetry does not
need stripped out.

### Approach

Create `src/statusline-worker.ts` by copying `src/usage-worker.ts`: a pure exported `Scanner`
(`onChange` reads a leaf, builds a typed `SessionTelemetry` message keyed on the RAW `session_id`
from the leaf CONTENT, a `statuslineGateKey` that EXCLUDES churny fields, a `lastEmitted` map,
and `seedFromDb` reconstructing the SAME gate key from the jobs telemetry columns), a
`@parcel/watcher` recursive subscribe on `resolveStatuslineRoot()` (new in `src/db.ts` mirroring
`resolveUsageRoot` `:499`, `KEEPER_STATUSLINE_DIR`-overridable), `RescanScheduler` drop-recovery,
a boot scan, the `disableNativeWatcher` seam (skip the `import("@parcel/watcher")` when set), an
`isMainThread` guard, a read-only `openDb`, and a shutdown handler that `unsubscribe()`s.

STRIP the usage-worker behaviors that do not apply: NO liveness-heartbeat re-emit, and NO
delete-tombstone/retraction (a leaf delete must NOT null jobs telemetry — an ended row keeps its
last-known values). ADD a bounded leaf GC in the boot-scan sweep: delete leaves whose session is
terminal/absent or older than a TTL, so keeper-owned leaves do not grow unbounded.

Register `"statusline"` as a `WorkerName` (`src/daemon.ts:2058`), in `ALL_WORKERS` (`:2083`),
`WATCHER_WORKERS` (`:2111`), and `spawnedWorkers` (`:6171`); spawn gated on `want("statusline")`
mirroring the usage spawn (`:3950`). Add the `onmessage` mint (`:3966` style) calling
`serializeSessionTelemetry` + a `mintUsageEventTolerant`-style tolerant insert
(`$hook_event="SessionTelemetry"`, `$event_type="session_telemetry"`, `$session_id=<raw id from
leaf>`, `$data=serialize(...)`, all else null), then `wakePending=true; pumpWakes()`.

### Investigation targets

**Required** (read before coding):
- src/usage-worker.ts:560 — UsageScanner; :498 usageGateKey (the exclusion discipline); :809 seedFromDb; :900 main() (subscribe + rescan + boot scan + shutdown); :97 UsageWorkerData; :947 shutdown handler
- src/daemon.ts:3950 — usage worker spawn (want gate); :3966 onmessage mint; :3990 mintUsageEventTolerant; :2058/:2083/:2111/:6171 the four worker-registration sites
- src/db.ts:499 — resolveUsageRoot (clone as resolveStatuslineRoot)

**Optional** (reference as needed):
- src/rescan.ts — RescanScheduler / isDropError drop-recovery

### Risks

The gate key is the single biggest churn risk — it MUST exclude any monotonically-moving field (raw
tokens) or every render mints an event. The mint's `session_id` must be the RAW id from the leaf
content, not the sanitized filename, or the fold matches zero rows. The worker must honor
`disableNativeWatcher` (tests never boot a real watcher). Leaf GC must not race the sink's writes.
Keeping the copied heartbeat/tombstone paths would re-emit/retract wrongly — strip them.

### Test notes

Drive the pure `Scanner` directly (no Worker/watcher): assert gate-key coalescing (unchanged leaf →
no emit), the emitted message shape, that `seedFromDb` reconstructs the live key, and that GC removes
stale leaves. `sandboxEnv` + `KEEPER_STATUSLINE_DIR` under the per-test tmpdir; `retryUntil` for any async.

## Acceptance

- [ ] The worker watches the leaf dir, coalesces via a churn-safe gate key, and posts `SessionTelemetry`; main mints the synthetic event
- [ ] `"statusline"` is registered in all four worker lists and the worker honors `disableNativeWatcher`
- [ ] Heartbeat re-emit and delete-retraction are stripped; a bounded leaf GC prevents unbounded growth
- [ ] The pure `Scanner` is unit-tested without booting a Worker/watcher; `bun test` green

## Done summary
Added src/statusline-worker.ts: a file-watch producer that coalesces statusLine leaf changes into SessionTelemetry events (churn-safe gate key excluding input_tokens, seedFromDb suppression, stripped heartbeat/retraction, bounded leaf GC). Wired 'statusline' into all four daemon worker lists plus the spawn/mint block and added resolveStatuslineRoot in src/db.ts.
## Evidence
