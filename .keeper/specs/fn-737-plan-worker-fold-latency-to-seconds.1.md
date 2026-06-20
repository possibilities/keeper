## Description

**Size:** M
**Files:** src/plan-worker.ts, src/backstop-telemetry.ts, cli/keeper-watch.ts, scripts/backstop-stats.ts, test/plan-worker.test.ts

### Approach

Build the measurement foundation and ATTRIBUTE the slow fold transitions BEFORE any fix. Three pieces:

1. **Per-wake-path attribution.** Today the backstop record's `fast_path` names the EXPECTED path (the heartbeat that caught the miss), not which of FSEvents/reflog/db-poll should have fired and didn't — the one 210s rescue mis-attributes to `data_version_poll` when the real miss was a no-reflog-watch commit. Extend the missed-wake telemetry (via the existing `buildMissedWakeRecord` / `BackstopRecord` in src/backstop-telemetry.ts) to record WHY a wake was missed: minimally whether a reflog watch was present for the repo at the time (`reflog_watch: present|absent`) and which fast paths recently stamped `markFastPath`. Producer-side telemetry ONLY — never consulted in a fold, never written to the event log/projection. Sole-writer preserved: workers `postMessage({kind:"backstop"})`, only main appends `backstop.ndjson`.

2. **Controlled before/after latency harness.** A deterministic test/bench driving REAL git commits (Bun.spawnSync, mirroring test/plan-worker.test.ts) for BOTH (a) a pending-repo planctl change and (b) a no-pending-repo foreign commit, measuring op->snapshot fold latency and reporting p50/p95. Reuse the `backstopScanner()` synthetic-clock harness (test/plan-worker.test.ts:3563) and the `detectFoldLatency` event-log pairing (cli/keeper-watch.ts:658, threshold 5s) as the latency signal. THIS is the acceptance instrument for task .2.

3. **Baseline + measured diagnosis.** Run the harness against the current daemon, attribute the dominant slow path(s) with the new per-path telemetry, and WRITE THE FINDING into this task's Done summary: which safe lever .2 must pull (reflog-coverage widening / FSEvents-reliability / safe cadence). Build on the confirmed fact: `IGNORE_GLOBS` excludes `.git` (plan-worker.ts:419,440), so the broad recursive watch does NOT see `.git/logs/HEAD`; the per-repo reflog watch (pending-repos-only, reconcileReflogWatches:2943) is the only FSEvents commit signal and is correctly dir-not-file (handles atomic rename). The prime-suspect slow path: a commit in a repo with no pending path -> no reflog watch -> no DB write -> invisible until git-worker's 60s heartbeat.

### Investigation targets

**Required** (read before coding):
- src/plan-worker.ts:2895-3008 — reflog watches (pending-only at :2943), resolveReflogTarget, reconcileReflogWatches; :3263 RECONCILE_HEARTBEAT_MS=5_000 heartbeat; :3350 PLAN_DB_POLL_MS=100 db-poll; :1013 markFastPath / :1028 fireBackstop
- src/backstop-telemetry.ts:159 buildMissedWakeRecord (staleness_ms = now-lastFastPathAt), :91 BackstopRecord schema — where attribution is added
- src/git-worker.ts:353 HEARTBEAT_MS=60_000, :383 DATA_VERSION_SCHEDULE_FLOOR_MS=1000 — the foreign-commit->plan signal path
- cli/keeper-watch.ts:658 detectFoldLatency, :258 FOLD_LATENCY_REALTIME_THRESHOLD=5, :240 STALENESS_ALARM=30_000 (use `grep -a` — file has a binary byte)
- scripts/backstop-stats.ts:78 percentile (p50/p95/p99)
- test/plan-worker.test.ts:3563 backstopScanner() synthetic-clock harness; :2763/2868/2949 live-worker spawn with injected pollMs; Bun.spawnSync git-commit fixtures

**Optional:**
- src/db.ts:394 resolveBackstopLogPath (KEEPER_BACKSTOP_LOG)

### Risks

- Determinism: attribution is producer-side telemetry only — never read in a fold, never in the event log/projection.
- Sole-writer: only main appends backstop.ndjson; workers postMessage. Do not add a worker-side append.
- n=1 baseline: historical rescue-staleness is statistically empty — the CONTROLLED harness is the real baseline instrument, not a percentile over existing rescues.
- Use monotonic `performance.now()` for any intra-process duration math; Date.now only for wall-clock/cross-process labels.
- A new timer/bench resource must not leak into the strict shutdown teardown.

### Test notes

- The harness IS the test: assert it deterministically measures op->snapshot latency for BOTH the pending-repo and no-pending-repo cases (synthetic clock + real git fixtures).
- sandboxEnv(...) must cover KEEPER_BACKSTOP_LOG.

## Acceptance

- [ ] Backstop missed-wake telemetry extended with per-wake-path attribution (minimally: was a reflog watch present for the repo; which fast paths recently stamped markFastPath) — producer-side only, never in a fold, sole-writer preserved.
- [ ] A controlled, deterministic before/after fold-latency harness exists (real git commits for a pending-repo planctl change AND a no-pending-repo foreign commit), reporting op->snapshot p50/p95.
- [ ] Baseline p95 established and recorded; a MEASURED DIAGNOSIS in the Done summary names the dominant slow path(s) and the specific safe lever .2 must pull, with evidence.
- [ ] No determinism / in-HEAD-gate / RPC / hook changes; no DB writes from the poll/telemetry path; `bun test` green.

## Done summary
Built the fn-737 measurement foundation: (1) per-wake-path attribution — backstop missed-wake records now carry reflog_watch (present|absent for the rescued repo) + recent_fast_paths (labelled markFastPath stamps: fsevents/db-poll/recheck-pending within a 60s window), producer-side only, never in a fold, sole-writer preserved (workers postMessage, only main appends backstop.ndjson). (2) Controlled real-git op->snapshot latency harness (Bun.spawnSync git fixtures + real spawned plan-worker) for the pending-repo planctl change, the no-pending-repo foreign commit, and the reflogs-off fallback case, reporting p50/p95 and capturing the backstop attribution. MEASURED DIAGNOSIS: baseline p95 is ~250-330ms across ALL three cases (pending-repo p95~255ms via db-poll+reflog; no-pending foreign commit p95~204ms with ZERO heartbeat rescues; reflogs-off fallback ~217ms) — far under the 5s FOLD_LATENCY_REALTIME_THRESHOLD. The epic's prime-suspect hypothesis (a no-pending commit is invisible until the 5s/60s heartbeat) is DISPROVEN for a configured-root watch: the file-creation FSEvent bounces the path into pending and arms the .git/logs/HEAD reflog watch BEFORE the commit, and even reflogs-off degrades to a .git/HEAD fallback that watches the whole .git directory (a de-facto commit signal since a commit churns index/refs/COMMIT_EDITMSG). So the dominant production slow path is NOT the configured-root case but the NARROW gap the epic confirmed: a commit in a repo with NO pending planctl path AND not a configured watch root — no reflog watch is ever armed, no DB write, so it falls to the git-worker's 60s heartbeat. SAFE LEVER for .2: reflog-coverage WIDENING (arm a .git/logs/HEAD reflog watch for repos beyond the pending-only set — e.g. all discovered/configured roots), NOT heartbeat-cadence tightening and NOT FSEvents-reliability work (FSEvents proved robust in-harness). bun test test/plan-worker.test.ts green (119 pass).
## Evidence
