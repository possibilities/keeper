## Description

**Size:** S
**Files:** babysitters/performance/watch.ts, babysitters/agents/performance.md, README.md, test/keeper-watch.test.ts

### Approach

Consumer side. Replace the staleness_ms gate in the backstop-degraded
detector (watch.ts:1189-1212, STALENESS_ALARM=30_000 at :336) with
change-to-rescue latency bands: latency null or < MISSED_WAKE_LATENCY_
WARN_MS (10_000) → healthy, no finding (an idle-then-instant-rescue is
normal FSEvents delivery; liveness is the dead-man watchdog's job);
>= WARN → warning finding; >= MISSED_WAKE_LATENCY_CRIT_MS (60_000) →
critical. Records without the field (pre-deploy lines) classify as
healthy — never fall back to the idle-inflated staleness_ms for
classification, but keep raw staleness_ms in the finding evidence for
shakeout comparison. Bump FINGERPRINT_VERSION (:196) and
BACKSTOP_BASELINE_VERSION (:948) in the SAME commit (semantics change;
baseline sidecar reseeds silently — expected, documented behavior).
Revise babysitters/agents/performance.md backstop-degraded prose
(:101-105) and the README architecture staleness paragraph (:2214-2224)
to the new semantics, per epic Docs gaps. Verify the 1611s incident
replay: a rescue record with staleness_ms=1611292 and
change_to_rescue_ms=2000 yields NO finding.

### Investigation targets

**Required** (read before coding):
- babysitters/performance/watch.ts:1120-1294 — detectBackstopTelemetry, fire site :1189-1212, threshold :336
- babysitters/performance/watch.ts:196,948 — FINGERPRINT_VERSION, BACKSTOP_BASELINE_VERSION
- scripts/backstop-stats.ts — the field shape task 2 added (consume through computeStats)
- test/keeper-watch.test.ts — existing backstop-degraded cases to recalibrate

### Risks

- Mixed-version ndjson: the same file will hold old (no field) and new lines for the 100MB rotation lifetime — classification must be per-record, not per-file
- Forgetting either version bump leaves stale seen-state/baseline suppressing or re-firing wrongly — both in the same commit

### Test notes

Cases: latency 2_000 + staleness 1_611_292 → no finding (the incident); 15_000 → warning; 90_000 → critical; field absent → no finding; null → no finding. Baseline reseed on version bump observable in the sidecar.

## Acceptance

- [ ] Incident replay (1611s staleness, 2s latency) yields no finding; 90s latency yields critical; 15s yields warning
- [ ] Old-format records classify healthy; staleness_ms retained in evidence only
- [ ] Both version constants bumped in the same commit
- [ ] performance.md + README prose revised in place; bun test keeper-watch suite green

## Done summary
Replaced the idle-inflated staleness_ms gate in the backstop-degraded late-rescue detector with change_to_rescue_ms warn(10s)/crit(60s) bands; null/old-format/dirty-tree rescues classify healthy, raw staleness_ms retained in evidence only. Bumped FINGERPRINT_VERSION and BACKSTOP_BASELINE_VERSION together; revised performance.md + README prose.
## Evidence
