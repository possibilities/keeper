## Description

**Size:** M
**Files:** src/plan-worker.ts, src/git-worker.ts, src/transcript-worker.ts, src/rescan.ts, test/plan-worker.test.ts, test/git-worker.test.ts, test/transcript-worker.test.ts, test/rescan.test.ts

Wire the four `missed-wake` backstops to the foundation, including the
denominator plumbing (the "did the change-gated scan actually rescue
anything?" boolean that git/transcript don't expose today).

### Approach

Each worker stamps `last_fast_path_at` in-memory at every confirmed
fast-path fire (FSEvents onChange, data_version poll). On a heartbeat /
drop-recovery fire it computes `staleness_ms = now - last_fast_path_at`,
bumps counters, and posts a `{kind:"backstop"}` record (rescued = did the
change-gated scan emit?). plan-worker: generalize the existing
`logBackstopEmit` (src/plan-worker.ts:1380) to ALSO emit the uniform record
(keep its prose ALARM for humans). git-worker: thread an emitted-boolean
out of `emitSnapshot`/`reconcileRoots` (heartbeat body :2749). transcript:
thread it out of `scanJobsForTitles` (:966). rescan: use the injectable
`onError`/scan-result seam (src/rescan.ts:183) to record drop-recovery
rescues. Preserve every existing trigger line and the db-poll/fswatcher
(fast-path, low-key, NOT alarm) severity distinction.

### Investigation targets

**Required** (read before coding):
- src/plan-worker.ts:1354-1400 — logBackstopEmit + the heartbeat/db-poll/fswatcher-drop reason taxonomy to preserve and generalize.
- src/git-worker.ts:2749-2762 (heartbeat body), :344 (HEARTBEAT_MS) — emitSnapshot is change-gated/void today; plumb the emitted-boolean out.
- src/transcript-worker.ts:966-986 — heartbeat body; scanJobsForTitles change-gated by lastEmitted, no rescue-vs-noop signal today.
- src/rescan.ts:182-202 — RescanScheduler.run + injectable onError (drop-recovery path); test/rescan.test.ts:166 injected-sink pattern.
- src/backstop-telemetry.ts (from `.1`) — the record/counter API to call.

**Optional** (reference as needed):
- README.md ~1028-1043 — existing plan-worker heartbeat ALARM prose (informs the uniform wording).

### Risks

- Signature change to `emitSnapshot`/`scanJobsForTitles` (void → returns emitted-boolean): verify no other caller depends on the void return.
- Cold-boot first heartbeat: `last_fast_path_at == 0/null` must NOT report a giant false-alarm staleness — define a sentinel (null staleness on cold boot) so the histogram isn't poisoned.
- Shutdown guard: the telemetry emit must sit behind the same `if (shuttingDown) return` as the scan, so teardown doesn't write spurious records.

### Test notes

Per worker: a fake-clock test where the fast path is suppressed, the
heartbeat fires, and a `rescued:true` record with correct staleness is
posted; and a no-op heartbeat posts only a counter bump (rescued:false).
Assert db-poll/fswatcher fast-path triggers stay non-alarm.

## Acceptance

- [ ] plan/git/transcript heartbeats + rescan drop-recovery each post a uniform `missed-wake` record on fire with correct `staleness_ms`, `fast_path`, and `rescued` boolean.
- [ ] git `emitSnapshot` / transcript `scanJobsForTitles` expose an emitted-boolean; the denominator (rescued:false no-ops) is counted.
- [ ] plan-worker's existing `logBackstopEmit` ALARM preserved AND emits the uniform record; db-poll/fswatcher stay low-key (non-alarm).
- [ ] Cold-boot staleness sentinel handled (no false giant-staleness on first heartbeat).
- [ ] No behavior change to any scan/emit result; `bun test` green for all four workers.

## Done summary

## Evidence
