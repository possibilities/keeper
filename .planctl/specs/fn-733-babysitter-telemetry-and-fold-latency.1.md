## Description

**Size:** M
**Files:** cli/keeper-watch.ts, test/keeper-watch.test.ts

Add two pure detectors to the scanner: backstop-telemetry ingest and
event→projection fold-latency. Both plug into `scan()` over the existing
bounded read; impurity (the backstop file-read) is injected via `ScanDeps`.

### Approach

**Backstop-telemetry (degrading/held signal).** Read `resolveBackstopLogPath()`
via an injected `ScanDeps` file-read; parse with `computeStats` (import from
`scripts/backstop-stats.ts`) and the `src/backstop-telemetry.ts` record types.
Fire when (a) a `backstop-rescue` has `staleness_ms ≥ STALENESS_ALARM` (skip
`null` — cold boot), or (b) the per-`(backstop,class)` `fires_total` DELTA vs a
stored baseline exceeds `MISSED_WAKE_DELTA`. Baseline lives in a NEW sidecar
`backstop-baseline.json` under `KEEPER_WATCH_STATE_DIR` (the `SeenEntry.count`
scalar can't hold `{fires_total, rescues_total, dev, ino}`): seed silently on
first observation (cold-start parity), `current < baseline ⇒ reset ⇒ delta =
current` (Prometheus semantics), invalidate the whole baseline when the file
`(dev,ino)` changes. Atomic write (reuse `atomicWriteFile`). Fingerprint =
`${backstop} ${class}` (stable; no counts/ts). One fingerprint per bucket
(≤6 names × 2 classes).

**Fold-latency (per-tick fire).** Pure detector over the event window: pair
each `planctl_op` event (scaffold/done/approve) to the FIRST snapshot event
(`event_type='plan_snapshot'`, i.e. `EpicSnapshot`/`TaskSnapshot`) whose
`session_id` equals the op's target entity id — derive `{epic_id, task_id}`
from `planctl_target` via `parsePlanRef`; scaffold/epic ops pair to the
EpicSnapshot (epic id = the "board shows it" moment), task ops to the
TaskSnapshot (task id). `latency = snapshot.ts − op.ts`; fire per matched pair
where `latency ≥ FOLD_LATENCY_REALTIME_THRESHOLD` (≈5s — the "realtime path
failed / fell to the reconcile heartbeat or worse" line; expected ~50ms;
tunable DOWN as the core fix lands). SKIP unpaired ops (in-flight or
out-of-window — never a false infinite-latency). Re-fold guard: ignore pairs
where `snapshot.ts < op.ts` or `latency > FOLD_LATENCY_SANITY_CAP` (~1h). NOT a
`HELD_TICK_CATEGORIES` member — immutable events make holding pointless (it
just delays the same verdict and would bury a one-shot 92s spike); rely on the
per-pair fingerprint + cooldown so each op pages once. Read ONLY columns (`ts`,
`session_id`, `planctl_target`, `planctl_op`, `hook_event`/`event_type`) —
never parse `data`.

Add the new `Category` union members and module-scope threshold consts. Keep
`prepareStmts:false`. Degrade-don't-throw: a backstop read failure / absent /
empty file reads as healthy (no finding), never a crash.

### Investigation targets

**Required** (read before coding):
- cli/keeper-watch.ts:583 (`scan`), :109 (`Category`), :152 (`fingerprint`), :200-215 (thresholds), :797 (`SeenEntry`), :904 (`HELD_TICK_CATEGORIES`), :80 (`atomicWriteFile`)
- scripts/backstop-stats.ts:101 (`computeStats` — reuse) ; src/backstop-telemetry.ts:42-132 (record types)
- src/daemon.ts:1772-1856 (snapshot pk-in-session_id + ts-at-fold-time) ; src/derivers.ts `parsePlanRef`
- src/db.ts:405 (`resolveBackstopLogPath`)

**Optional** (reference as needed):
- test/backstop-stats.test.ts (NDJSON-detector test precedent)

### Risks

- Counter reset on daemon restart misread as a regression — Prometheus reset semantics + (dev,ino) baseline invalidation are the guard; test it explicitly.
- Re-fold mints fresh snapshot ts → carpet-fires fold-latency — the `snapshot.ts<op.ts` / sanity-cap guard covers it.
- In-flight op at the window tail falsely flagged — skip unpaired ops.

### Test notes

Backstop: feed synthetic ndjson text to the pure detector (precedent
test/backstop-stats.test.ts) — assert rescue-staleness fire, null-staleness
skip, baseline seed-then-delta, and counter-reset (current<baseline) handled.
Fold-latency: `insertEvent` a `planctl_op` row + a later matching snapshot row
(same `session_id`), assert pairing + threshold fire + in-flight skip + re-fold
guard. Sandbox all five `KEEPER_*` paths + `KEEPER_WATCH_STATE_DIR`; add to
`test:fast`.

## Acceptance

- [ ] Backstop detector fires on high-staleness rescues + missed-wake `fires_total` deltas; skips null staleness; absent/empty file = healthy
- [ ] Counter baseline persists across ticks in `backstop-baseline.json`, uses reset semantics, invalidates on file-identity change
- [ ] Fold-latency pairs op→first-matching snapshot, fires ≥ threshold per-tick with cooldown, skips in-flight + re-fold pairs
- [ ] Backstop ingest catches today's incident (staleness=143108 fixture); fold-latency catches the fn-732 ~10-20s fixture
- [ ] New detectors pure + injected-deps; `prepareStmts:false`; never writes keeper.db
- [ ] Five `KEEPER_*` + `KEEPER_WATCH_STATE_DIR` sandboxed; `bun run lint && typecheck && test:fast` pass

## Done summary
Added two pure detectors to keeper-watch: backstop-telemetry ingest (fires on high-staleness rescues + missed-wake fires_total deltas with Prometheus reset + (dev,ino) baseline invalidation via a new backstop-baseline.json sidecar) and fold-latency (pairs each planctl_op to the first matching plan_snapshot, fires >= the realtime bar, skips in-flight + re-fold artifacts). Both wired into scan via injected ScanDeps; prepareStmts:false preserved; never writes keeper.db. Catches today's staleness=143108 incident and the fn-732 ~10-20s fold-latency fixture.
## Evidence
