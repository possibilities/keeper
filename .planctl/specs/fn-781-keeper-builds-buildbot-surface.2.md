## Description

**Size:** M
**Files:** src/builds-worker.ts, src/daemon.ts, src/db.ts, test/builds-worker.test.ts

### Approach

Keeper's first HTTP-polling producer. Config first: add `buildbot_url` to
`KeeperConfig` + `resolveConfig` (src/db.ts) as an independent best-effort
key mirroring `agentuse_root` (non-empty string guard; absent/garbage ->
worker not spawned). Worker `src/builds-worker.ts` on the usage-worker
archetype: isMainThread guard, validated workerData (buildbot URL, db
path, optional poll interval for tests), own read-only openDb solely to
seed the change-gate from the `builds` projection on boot (restart must
not re-emit), typed `{kind:"build-snapshot"|"build-deleted"}` messages
out, `{type:"shutdown"}` in.

Poll loop: setTimeout-after-completion with an in-flight skip flag (NEVER
setInterval — a hung request skips slots, it does not queue). Each fetch
gets a manual AbortController deadline (~10s) with clearTimeout in
finally (AbortSignal.timeout is buggy on Bun/macOS, oven-sh/bun#7512),
combined with the worker shutdown signal via AbortSignal.any so shutdown
aborts in-flight requests; the shutdown handler also clears the pending
timer. ALL transient errors (fetch failure, non-2xx, non-JSON 200 body,
partial cycles) are caught INSIDE the loop and degrade to a silent no-op
— they must never reach the worker's top-level error path, because main
wires onerror/close to fatalExit and buildbot-down must not crash-loop
the daemon. Fixed cadence, no backoff, no circuit breaker.

Cycle: GET /api/v2/builders, filter ghosts (empty masterids); per builder
GET /api/v2/builders/<id>/builds?order=-number&limit=1 (order=-number,
not -buildid). Empty builds array -> no message. Change-gate keyed by
builder NAME hashing exactly (build_number, complete, results,
started_at, complete_at) — state_string is captured in the message but
EXCLUDED from gate identity (a build emits exactly two events: start,
finish). Gate is PRESERVED on any fetch failure (a reset would emit
spurious events on recovery). Per-builder isolation: one failed
per-builder fetch skips that builder and preserves its gate; others
proceed. Disappearance: a builder present in the seeded/seen set but
absent from a SUCCESSFUL enumeration emits build-deleted (never infer
deletion from a failed cycle).

Daemon: add "builds" to WorkerName and ALL_WORKERS but NOT
WATCHER_WORKERS (that list gates the watcher-only native-addon pre-warm);
spawn gated on want("builds") AND a configured buildbot_url, mirroring
the usage spawn; onmessage maps kinds to BuildSnapshot/BuildDeleted via
the task-1 serializer -> stmts.insertEvent -> wakePending=true;
pumpWakes(). onerror/close -> fatalExit (per contract). Keep all worker
code daemon-side — nothing imports into the hook path.

### Investigation targets

**Required** (read before coding):
- src/usage-worker.ts:654 — seedFromDb change-gate seed (slot-order is load-bearing: seed must reconstruct gate keys byte-for-byte from projection columns or every boot re-emits); gate key at :420; main() contract at :717
- src/daemon.ts:3009-3095 — usageWorker spawn + onmessage/onerror/close, the wiring template including resolveUsageRoot-style config resolution at :3013
- src/daemon.ts:1408,1430,1452 — WorkerName / ALL_WORKERS / WATCHER_WORKERS; the ALL_WORKERS comment marks the production-boot regression test whose expected worker list/count must be updated — check how that test handles conditionally-spawned workers
- src/db.ts:126-216 — resolveConfig independent-key pattern (mirror agentuse_root); KeeperConfig at :90
- src/daemon.ts:2913-2967 — GitSnapshot insertEvent handler, the canonical synthetic-event INSERT field list (entity pk in $session_id, payload in $data, rest NULL)

**Optional** (reference as needed):
- test/usage-worker.test.ts — change-gate suppression test shape (usageGateKey)
- test/helpers/sandbox-env.ts — sandboxEnv for any test that spawns real processes

### Risks

The poll loop + teardown is net-new (no existing worker has this shape) —
the keystone risk. Specific traps: an uncleared deadline timer aborting
the NEXT request's signal; a fetch rejection escaping to onerror ->
daemon crash-loop; gate-seed drift re-emitting every builder on every
daemon restart; inferring deletion from a failed enumeration.

### Test notes

Factor the pure pieces (gate key/hash, API-response parsing + ghost
filter, deletion diff against the seen set) as exported functions and
unit-test them in the fast tier. Worker process-level tests, if any, are
slow-tier. This task touches daemon/worker/db process paths: `bun run
test:full` is mandatory before landing. Manual smoke: set buildbot_url,
restart keeperd, force a build, watch the events table gain exactly two
BuildSnapshot rows; stop buildbot, confirm zero events and no crash.

## Acceptance

- [ ] buildbot_url parsed as independent best-effort config key; absent/empty -> builds worker not spawned, daemon boots normally
- [ ] Worker polls on setTimeout-after-completion with in-flight skip; per-fetch abort deadline; shutdown aborts in-flight fetch and clears the timer
- [ ] Buildbot down/unreachable/non-JSON: zero events, zero worker errors, daemon stays up; gate preserved so recovery emits nothing spurious
- [ ] Unchanged state emits zero events; a build emits exactly two (start, finish); state_string excluded from gate identity (unit-tested)
- [ ] Never-built builders emit nothing; ghost builders (empty masterids) filtered; builder disappearance from a successful enumeration emits build-deleted (unit-tested diff)
- [ ] Gate seeded from builds projection on boot — daemon restart with unchanged buildbot emits zero events
- [ ] "builds" in WorkerName + ALL_WORKERS (regression test updated), NOT in WATCHER_WORKERS; onmessage feeds events only via stmts.insertEvent + pumpWakes
- [ ] bun run test:full green

## Done summary

## Evidence
