## Description

**Size:** M
**Files:** src/autopilot-worker.ts, src/reconcile-core.ts, test/autopilot-worker.test.ts

### Approach

Add a `computeBaseDriftEntries` PRODUCER probe modeled on `computeStaleBaseLaneEntries`
(:2863) / `computeDeferredEpicIds` (:2403): per (epic, laneRepo), call `.1`'s primitives,
compare against `.3`'s thresholds, and emit `baseDriftEntries` (plain serializable data:
which lanes exceed drift + magnitude) into the snapshot alongside deferred/landed/staleBase
at the `loadReconcileSnapshot` hook (:7399-7423). Gate strictly on `worktreeMode` (OFF cycle =
zero git spawns, empty result); memoize per-repo; never throw out of the snapshot build.
Thread the data onto `ReconcileSnapshot` and read it in the PURE reconcile core as plain
data ONLY — no git/clock/fold (`reconcile-core-depgraph.test.ts` bans git value-imports into
the pure core). Mind the vacuous-ancestor trap (:2839-2848): a freshly-cut/empty lane must
resolve NOT-drifted unless it genuinely exceeds threshold; defer on any inconclusive primitive.

### Investigation targets

*Verify before relying — the repo moves.*

**Required:**
- src/autopilot-worker.ts:2863 — `computeStaleBaseLaneEntries` (closest prior art; vacuous-ancestor trap :2839-2848)
- src/autopilot-worker.ts:2403 — `computeDeferredEpicIds` (merge-gate probe idiom)
- src/autopilot-worker.ts:7399-7423 — `loadReconcileSnapshot` hook site (deferred/landed/staleBase computed side-by-side)
- src/autopilot-worker.ts:4118-4122 — provision fork-source (the drift origin: base never refreshed until finalize)

**Optional:**
- src/reconcile-core.ts:2446 / :2618 — pure geometry consuming the snapshot
- src/worktree-plan.ts:133 — `baseBranchFor`

### Risks

Per-(epic,repo) keying must mirror existing distress keying for `worktree_multi_repo`. This probe is READ-only — it emits data, it does NOT merge (that is `.4`).

### Test notes

`test/autopilot-worker.test.ts` with a faked `WorktreeGitRunner`: drifted lane → entry with magnitude; fresh lane → no entry; inconclusive → no entry (defer). Keep `reconcile-core-depgraph.test.ts` green.

## Acceptance

- [ ] `loadReconcileSnapshot` emits `baseDriftEntries` as plain snapshot data for lanes exceeding the configured drift threshold, worktreeMode-gated (OFF ⇒ empty, zero git spawns).
- [ ] A fresh-lane / inconclusive case yields no drift entry (defer), never a false positive.
- [ ] The pure reconcile core reads the data without importing git/fs; the dep-pin test stays green.

## Done summary

## Evidence
