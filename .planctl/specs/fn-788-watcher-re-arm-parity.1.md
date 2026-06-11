## Description

**Size:** M
**Files:** src/plan-worker.ts, test/plan-worker.test.ts, README.md

### Approach

Mirror the git-worker fn-771 re-arm into the plan-worker's MAIN .planctl tree
subscriptions. Three structural moves: (1) key the flat
`subscriptions: AsyncSubscription[]` (built once at ~:3255, pushed ~:3393) by
root — a `Map<string, AsyncSubscription>` — so a rescued root maps to its
subscription; (2) give the heartbeat per-root rescue attribution — the 5s
heartbeat currently gets ONE aggregate `rescued` boolean from
`reconcilePlanctlDirs(data.roots, ..., "heartbeat", ...)`; refactor so the
scan reports WHICH roots emitted (mirroring git-worker's per-root
emitSnapshot loop at git-worker.ts:2503-2559) and feed exactly those roots
into a `pendingResubscribe` set — re-arming all roots on any rescue is the
stream-flap vector, rejected; (3) drain the set with a bounded, sequential,
tombstone-free replace: `await unsubscribe()` THEN fresh
`watcher.subscribe(root, ...)` with the IDENTICAL options
(`{ ignore: IGNORE_GLOBS }`, positive globs only), one attempt per root per
drain, capped per cycle (MAX_SUBSCRIBES_PER_CYCLE=16 is the precedent; the
root set is small so the cap is cheap insurance), flag deleted on drain
(one-shot; a re-mute re-flags), guarded by `shuttingDown` and the
`disableNativeWatcher` seam (early-return — no native sub exists under the
in-process harness). Reuse `makeSingleFlight` for drain/reconcile coordination
so a db-poll wake and a re-arm drain never race on the subscription map.

The re-arm must NOT reset producer state: only the watcher subscription is
replaced — the PlanScanner change-gate / lastEmitted survives, so the
post-re-arm full pass (the existing reconcilePlanctlDirs) re-emits nothing
that didn't actually change (no phantom re-folds). Re-subscribe failure is
non-fatal: log and leave the root unwatched; the next heartbeat rescue
re-flags it. When `reflogWatchAttribution()` reports a present-but-mute
reflog watch for an implicated repo, also drop that repo's entry from
`reflogSubs` so the existing `reconcileReflogWatches` re-derives it — reuse
that loop, do not build a second reflog re-arm path.

Extract the re-arm decision (rescued roots + cap -> which roots to tear down
this cycle) as a PURE exported helper (the `reflogWatchDiff` /
`decideReconcileTransitions` model) and unit-test it in
test/plan-worker.test.ts — no live-watcher tests. Log each re-arm fire with a
`[plan-worker]` stderr line naming the root, and log the watcher callback
`err` argument before re-arming (distinguishes "OS told us" from silent mute).

Update README: the design-principles bullet (~268-274) — scope "without
re-subscribing" to the dropped-events re-scan path and name the mute-stream
re-subscribe path, keeping the "data recovery, not process self-heal"
boundary sentence — and the plan-worker paragraph (~2014-2019), present
tense, no change-history framing.

### Investigation targets

**Required** (read before coding):
- src/git-worker.ts:1776-1791, 2256-2284, 2313-2330, 2503-2559 — the complete re-arm precedent: flag contract, NOT-a-drop teardown, bounded drain, heartbeat flagging site
- src/plan-worker.ts:2922, 3255-3401 — the flat subscriptions array + the boot subscribe loop to key by root
- src/plan-worker.ts:3099-3141 — the heartbeat: where the aggregate rescued boolean comes from and where per-root attribution must land
- src/plan-worker.ts:2607-2746 — reflogWatchDiff (the pure-helper model) + reflogSubs/reconcileReflogWatches (the keyed loop to reuse for reflog re-arm)
- src/plan-worker.ts:3183-3218 — makeSingleFlight db-poll wake (the coordination seam)

**Optional** (reference as needed):
- test/git-worker.test.ts:2389-2405, 3140-3210 — the pure decision-helper and missed-wake record test patterns to mirror
- src/rescan.ts — RescanScheduler/isDropError: the dropped-events path is DISTINCT from re-arm; do not conflate or modify it

### Risks

The per-root attribution refactor touches the heartbeat's scan call shape —
keep `fireBackstop`'s rescued boolean semantics byte-compatible (the backstop
record and counters must not change meaning). If per-root attribution proves
invasive, the sanctioned fallback is re-arming the full (small) root set
under the cap with a survive-one-heartbeat flap guard — note the tradeoff in
the Done summary rather than forcing the refactor.

### Test notes

Pure unit tests for the decision helper (empty set, cap overflow, one-shot
flag semantics, re-mute re-flag). `bun run test:full` mandatory — worker
paths are slow-tier.

## Acceptance

- [ ] A plan-heartbeat rescue re-arms exactly the implicated root(s), sequentially (unsubscribe completes before subscribe), with identical subscribe options
- [ ] Healthy roots are never re-armed; the flag is one-shot and capped per cycle
- [ ] PlanScanner state survives a re-arm: no phantom plan re-emits after the replace (covered by a unit test on the decision helper + scanner-untouched assertion)
- [ ] Re-subscribe failure is non-fatal and the root re-flags on the next rescue
- [ ] Pure exported decision helper with unit tests; README design-principles bullet + plan-worker paragraph updated
- [ ] `bun run test:full` green

## Done summary

## Evidence
