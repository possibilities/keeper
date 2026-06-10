## Overview

Two signal-quality fixes for the performance babysitter, both from the
2026-06-10 incidents: (1) it reported "probably benign" (dup-dispatch,
3-min window) while epic fn-12 accumulated 8 close workers over ~6h
without ever flipping done — a slow close-loop the rate-window arm is
structurally blind to; (2) it paged critical "git-heartbeat rescued 1611s
behind" for a rescue whose true change-to-rescue latency was ~2 seconds
(the heartbeat caught commit a3987ad 2s after it landed; staleness_ms =
now − last_fast_path_at inflates with 27 quiet minutes). End state: a
close-loop detector pages critical on accumulating close dispatches
against a still-open epic; the missed-wake detector classifies on true
change-to-rescue latency with warning/critical bands; and a missed-wake
rescue kicks the root's watcher re-subscribe through the existing
reconcile path.

## Quick commands

- `bun test test/keeper-watch.test.ts test/backstop-telemetry.test.ts test/backstop-stats.test.ts` — detector + builder + parser suites
- `bun run test:full` — MANDATORY gate (touches git-worker / daemon paths; fast tier does not cover them)

## Acceptance

- [ ] A plan_ref with ≥4 close jobs created within 24h while its epic is still open yields a critical `close-loop` finding; an epic that flipped done yields none
- [ ] A missed-wake rescue of a 2s-old commit after 27 idle minutes yields NO critical finding; a 90s-old delivered change yields critical; 10-60s yields warning
- [ ] backstop.ndjson missed-wake records carry the change-to-rescue latency field; old records without it parse cleanly (null, no finding)
- [ ] A missed-wake rescue flags the root for watcher re-subscribe via the level-triggered reconcile (no direct unsubscribe/resubscribe in the heartbeat, no worker respawn, no DB write)
- [ ] FINGERPRINT_VERSION and BACKSTOP_BASELINE_VERSION bumped together with the semantics change

## Early proof point

Task that proves the approach: ordinal 2 (change-to-rescue latency
derivable at emitSnapshot time and threaded through buildMissedWakeRecord).
If it fails: fall back to sitter-side-only calibration — gate the existing
staleness_ms finding on a recent-fast-path-activity heuristic, weaker but
still kills the idle-inflation false-critical.

## References

- Incident A (close-loop): fn-12-crush-close-skill-into-coordinator, 2026-06-10 — 8 close jobs 08:07Z→14:08Z (4 ended, 4 killed), 2 pending-dispatch-sweep timeout rescues, epic open throughout; babysitter finding said "count of 2 ... probably benign"
- Incident B (missed-wake): 14:04:09Z rescue, staleness_ms=1611292, last_fast_path_at=13:37:18Z; rescued change was commit a3987ad authored 14:04:07Z — true latency ~2s
- The dup-dispatch detector doc comment (watch.ts:272-403) explains why count-of-2 in a rate window is legitimately benign (fn-762 aborted-prelaunch cooldown-clear) — the close-loop detector is the missing state-based sibling arm, not a replacement
- Practice grounding: Kubernetes CrashLoopBackOff dual-arm (state + rate) detection; Google Chronicle event-ts vs observation-ts lag discipline; freshness SLOs gated on "an event actually arrived"
- Decisions locked at planning: jobs-row counting (pre-launch aborts spawn no worker, so no row = no harm signal); 24h window, N≥4; epic-status correlation keyed by epic_id (done rows visible by id; missing row → degrade, no finding); non-commit (dirty-tree) rescues anchor null → no critical; multi-commit rescue anchors worst-case (oldest); negative latency clamps healthy; re-arm is reconcile-kick only

## Docs gaps

- **babysitters/agents/performance.md**: add `close-loop` to the category enum (:53-56) and a per-category prose entry modeled on duplicate-live-workers (:109-116); REVISE the backstop-degraded entry (:101-105) to the new latency semantics
- **README.md**: add close-loop to the failure-class parenthetical (~:451); revise the architecture staleness-alarm paragraph (:2214-2224) in place to describe change-to-rescue latency

## Best practices

- **Dual-arm loop detection:** rate windows catch fast loops, cumulative state catches slow ones spaced by cooldowns — keep both arms [sysdig.com/blog/debug-kubernetes-crashloopbackoff]
- **Lag = observation_ts − event_ts, never now − last_observation** — the latter measures idleness, not latency [docs.cloud.google.com/chronicle/docs/detection/timestamp-definitions]
- **Gate freshness checks on "an event actually arrived";** absence of events is a liveness question with a different detector (the dead-man watchdog)
- **Key loop counters on the durable work-item id** (plan_ref), never worker pid/tab — instance-keyed counters reset every re-dispatch and go blind
