## Description

**Size:** M
**Files:** src/git-worker.ts, test/git-worker.test.ts

### Approach

Three producer-side fixes, all in `src/git-worker.ts`: (1) Replace the
`JSON.stringify(snapshot)` dedupe key (line 2177) with a SEMANTIC key over
render-significant fields only — project_dir, head oid, upstream, ahead,
behind, and per-dirty-file {path, status, mode, worktree_oid, index_oid} —
explicitly EXCLUDING `mtime_ms` (and any field that churns without changing
meaning). Keep `mtime_ms` + `worktree_oid` in the emitted PAYLOAD (the
reducer needs them). (2) Pass a max-wait ceiling (from task .1) into
`schedulerFor(root)` so emission coalesces to ≤1 per root per ~1-2s,
latest-wins. (3) Narrow the `data_version` poll wake (2537-2547) so a bump
does NOT reschedule every subscribed root — only reconcile membership and
schedule newly-subscribed / membership-changed roots; gate real-work
scheduling on an actual version advance plus a min-elapsed floor so the
worker's own GitSnapshot round-trips don't re-trigger it. Preserve the
`snapshotSuppressedByDivergence` wedge guard on the live emit path (it must
keep firing — do not move it behind the throttle) and the 60s heartbeat
backstop. Log a coalesced-drop counter.

### Investigation targets

**Required** (read before coding):
- src/git-worker.ts:2177-2179 — JSON.stringify dedupe key + lastByRoot compare (semantic-key target)
- src/git-worker.ts:1861 — buildGitSnapshot: the GitDirtyFile fields available for the semantic key (path/status/mode/worktree_oid/index_oid vs mtime_ms)
- src/git-worker.ts:2028 + 2213 — emitSnapshot body + snapshotSuppressedByDivergence wedge guard (runs before dedupe; must stay on live path)
- src/git-worker.ts:2186 — schedulerFor(root) seam (pass the task-.1 ceiling here)
- src/git-worker.ts:2537-2547 — data_version poll reschedules every root (narrowing target); :2553-2562 heartbeat backstop
- reducer.ts:2096 (inferred attribution uses mtime), reducer.ts:2031/2605 (discharge uses worktree_oid) — proof these payload fields must stay

### Risks

- Narrowing the wake too far could miss a real foreign dirty-tree write (a hook tool event dirtying a repo) → board shows stale clean status. Gate on data_version-advanced-by-other + membership, not on dropping the poll.
- The semantic key must not change WHICH distinct snapshots emit (only coalesce ones a correct dedupe would have dropped) — else re-fold diverges.
- Wedge-guard ordering: suppression must run before/independent of the throttle.

### Test notes

Add git-worker tests: (a) same render-significant state + different mtime → no second emit; (b) genuinely-changed dirty set → emits; (c) under simulated continuous churn the per-root emit rate is bounded by the throttle window; (d) wedge guard still fires when HEAD diverges. Verify end-to-end with scripts/bench-latency.ts and the live GitSnapshot/min query.

## Acceptance

- [ ] Dedupe key is semantic (excludes mtime_ms); mtime_ms + worktree_oid still in the emitted payload
- [ ] Per-root emission is throttled to ≤1 per ~1-2s under continuous churn (test-pinned)
- [ ] data_version wake no longer reschedules every root on every bump; the worker's own inserts don't re-trigger emission
- [ ] A real foreign dirty-tree change is still observed (not missed by the narrowed wake)
- [ ] snapshotSuppressedByDivergence still fires on HEAD divergence
- [ ] Coalesced-drop count logged; GitSnapshot/min measurably down via bench-latency.ts
- [ ] From-scratch re-fold reproduces byte-identical projections

## Done summary
Producer-side GitSnapshot throttle: semantic dedupe key (excludes mtime_ms, keeps it + worktree_oid in the payload), GIT_SNAPSHOT_MAX_WAIT_MS ceiling capping continuous-churn emission to <=1/~1.5s, narrowed data_version wake (membership-only on self-writes via a min-elapsed floor), and a coalesced-drop counter logged on the heartbeat. All producer-only; re-fold determinism preserved.
## Evidence
