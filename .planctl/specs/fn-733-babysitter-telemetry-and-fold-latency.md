## Overview

The babysitter (fn-729) only measures reducer-cursor lag, so it is blind to
the failure class that actually bit us: a planctl scaffold taking 92s (and,
live during this very epic's creation, 10-20s) to reach the board while the
reducer was caught up (lag ≈0). The slowness lived in keeper's realtime WAKE
paths failing and falling to slow backstops — and keeper already RECORDS this
in `~/.local/state/keeper/backstop.ndjson` (plan/git/transcript missed-wake
counters, a pending-dispatch-sweep rescue at staleness_ms=143108). Nobody was
reading it. This epic gives the babysitter three new eyes: (1) ingest
keeper's backstop self-telemetry, (2) measure event→projection FOLD LATENCY
against a realtime bar, and (3) a self-watchdog so the babysitter can't die
silently. It is the detection SAFETY-NET; the keeper-core fix for WHY the
realtime wakes degrade is a separate future epic (out of scope here).

Same posture as fn-729: read-only external observer (never writes keeper.db,
no synthetic events, no RPC), pure `(input)=>Finding[]` detectors with
injected impurity, unit-tested, biome-linted.

## Quick commands

- `bun run cli/keeper-watch.ts --json` — findings now include backstop + fold-latency categories
- `bun run test:fast` — the new detector unit tests
- `cat ~/.local/state/keeper/backstop.ndjson | tail` — the telemetry source being ingested
- `cat ~/.local/state/keeper-watch/heartbeat.json` — the babysitter's liveness heartbeat
- `launchctl print gui/$(id -u)/arthack.keeper-watchdog` — the external dead-man check

## Acceptance

- [ ] `keeper-watch` ingests `backstop.ndjson` and fires on backstop-rescue (high staleness_ms) + rising missed-wake counter deltas
- [ ] Backstop counters use delta-vs-baseline with Prometheus reset semantics; baseline survives ticks and resets cleanly on daemon restart / file-identity change
- [ ] `keeper-watch` measures fold latency (op→matching snapshot) and fires at the realtime threshold, per-tick with cooldown, skipping in-flight + re-fold artifacts
- [ ] The babysitter writes a liveness heartbeat each completed tick; a separate launchd watchdog alarms if it goes stale
- [ ] All new detectors are pure + unit-tested; five `KEEPER_*` paths + `KEEPER_WATCH_STATE_DIR` sandboxed; `bun run lint && typecheck && test:fast` pass
- [ ] Backstop ingest would have caught today's incident (proven against a fixture)

## Early proof point

Task that proves the approach: `.1` (backstop ingest + fold-latency). It is
provable against today's live evidence: the `backstop.ndjson` rescue at
staleness_ms=143108 and the fn-732 scaffold op→EpicSnapshot ~10-20s pair are
ready-made fixtures. If the backstop ingest can't cleanly distinguish a real
missed-wake delta from a daemon-restart counter reset, the detection model is
wrong and we rethink before the watchdog.

## References

- Live evidence (2026-06-07): `backstop.ndjson` — `backstop-rollup` (plan-heartbeat fires_total=17, git/transcript=64, monotonic + RESET on restart), `backstop-rescue` (class timeout, backstop pending-dispatch-sweep, staleness_ms=143108); fn-732 scaffold op ts 1780868476.689 → EpicSnapshot ts 1780868486.905 (~10s) → last TaskSnapshot 1780868506.862 (~20s).
- REUSE `scripts/backstop-stats.ts:101` `computeStats(text)` — tolerant NDJSON parse (take-last rollup per (backstop,class), null-staleness skip, torn-tail tolerance). Import, don't re-parse.
- Import `src/backstop-telemetry.ts:42-132` types (`BackstopRecord`, `BackstopRollup`, `BackstopName`, `BackstopClass`) — don't redefine.
- Fold-latency pairing (`src/daemon.ts:1772-1856`, VERIFIED): `EpicSnapshot`/`TaskSnapshot` synthetic events carry the entity pk in `session_id`, `event_type='plan_snapshot'`, `ts = Date.now()/1000` at fold time (the re-fold hazard); the op carries the id in `events.planctl_target`/`planctl_op`. `src/derivers.ts` `parsePlanRef`/`derivePlanFields` split `planctl_target → {epic_id, task_id}`.
- `cli/keeper-watch.ts`: `scan` :583, `tick` :1194, `Category` union :109, `fingerprint` :152, thresholds :200-215, `HELD_TICK_CATEGORIES` :904, `SeenEntry.count` :797 (too narrow for backstop baseline), `atomicWriteFile` import :80, `resolveSeenStatePath`/`KEEPER_WATCH_STATE_DIR`.
- `src/db.ts:405` `resolveBackstopLogPath()` (honors `KEEPER_BACKSTOP_LOG`) — read the sidecar via an injected `ScanDeps` file-read.
- Dead-man template: `~/.local/state/keeper/{orphanwatch,dropwatch}.sh` + `plist/arthack.keeper-orphanwatch.plist` (StartInterval 600, RunAtLoad, silent first-run, daily all-clear, PATH incl `~/.local/bin`, single-flight lock). Babysitter tick template: `plist/arthack.keeper-babysit.plist` (StartInterval 300).
- **OUT OF SCOPE (separate future epic): the keeper-CORE fix** for why realtime wakes degrade (FSEvents drops / reflog-watch reconcile / event-flood contention / the 143s stale dispatch). This epic detects it; it does not fix it.

## Best practices

- **Monotonic counters:** alert on the DELTA, never the absolute; `current < baseline ⇒ reset ⇒ delta = current` (Prometheus `rate()` semantics); key the baseline on file `(dev,ino)` and invalidate on identity change. [Robust Perception]
- **Latency SLO:** measure from the event's own `ts` to the fold's `ts` (never the monitor's read time — it's 5 min late by design); skip ops with no snapshot yet (in-flight); guard re-fold artifacts (`snapshot.ts < op.ts` / absurd latency). [Google SRE Workbook]
- **Dead-man:** the watchdog MUST be a separate launchd job (a broken monitor agent never runs its own watchdog); heartbeat written AFTER successful work; staleness threshold ≥ 3× interval for launchd jitter; alert actively (notifyctl/botctl), never log-only. [launchd.info]
- **Always-exit-0:** a backstop read error / heartbeat write failure degrades to no-finding (and a later watchdog alarm), never a wedged tick.

## Docs gaps

- **README.md**: install step 8 detection-class list (+backstop, +fold-latency, +self-watchdog); a step 8b for the new `arthack.keeper-watchdog` LaunchAgent (ln -s + bootstrap); uninstall (watchdog bootout+rm); architecture babysitter paragraph (new detection surface + the external dead-man).
- **CLAUDE.md** (~L77-80): note `backstop.ndjson` as a second read-only input to the babysitter, keeping the no-write/no-RPC constraint.
