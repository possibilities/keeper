## Description

**Size:** S
**Files:** src/git-worker.ts, test/git-worker.test.ts

The authoritative commit-ingest channel (fn-681 `planctl-commit-changed`)
went silent for the observed close commits. Leading suspect:
`src/git-worker.ts:1945` advances the per-root HEAD-oid cache
(`lastHeadOidByRoot.set(root, currentHeadOid)`) UNCONDITIONALLY, even when
`enumerateCommitsInDelta` threw (caught at ~:1931). The failed commit is
then never re-enumerated against the next observation — its
`planctl-commit-changed` (and `Commit`) is permanently lost, forcing the
projection onto FSEvents + the 60s heartbeat. Investigate, confirm the
mode from the live logs, and fix so a transient enumeration failure does
not silently drop a commit.

### Approach

- Confirm the silence mode from `~/.local/state/keeper/server.stderr`:
  a `commit enumeration failed`-style stderr line near a
  `backstop (heartbeat) emitted` for a path that should have arrived via
  the commit channel.
- Fix the unconditional advance: on an `enumerateCommitsInDelta` throw, do
  NOT advance `lastHeadOidByRoot` past the failed range (or record the
  range in a retry list re-attempted next observation), so the next
  HEAD-oid change re-enumerates and re-emits. Keep the producer-only
  contract: a failed enumeration still must not wedge the worker
  (log+continue).
- Verify the divergence-wedge path (`snapshotSuppressedByDivergence`,
  ~:1864): while suppressed, the head-cache must NOT advance so commits in
  that window re-enumerate once the wedge clears. Confirm or fix.
- First-sighting seed (~:1876-1877) intentionally emits no commits on the
  first observation of a root — out of scope here; the brand-new-repo
  case is T3's `.git/logs/HEAD` watch + the T1 poll backstop.

### Investigation targets

**Required** (read before coding):
- src/git-worker.ts:1842-1946 — `emitSnapshot` HEAD-oid delta + `planctl-commit-changed` emission; esp. :1931 (enumeration try/catch) and :1945 (the unconditional head-cache advance)
- src/git-worker.ts:1864 — `snapshotSuppressedByDivergence` suppression block
- src/daemon.ts:2332-2347 — the `planctl-commit-changed` forward to plan-worker

**Optional** (reference as needed):
- src/git-worker.ts:901-944 — `filterPlanctlChanges`/`isPlanctlChangedPath` (the planctl-path filter; lockstep-duplicated from plan-worker's classifier)
- test/git-worker.test.ts — existing commit-enumeration / snapshot tests to extend

### Risks

- Not advancing the head-cache on a throw risks a hot re-enumeration loop if the failure is persistent (e.g. a permanently corrupt object). Bound retries or advance-after-N-failures with a loud log, rather than spinning.
- Re-fold determinism: this is producer-side only; no reducer/schema change. Confirm replayed `planctl-commit-changed` stays idempotent at the plan-worker (the change-gate absorbs a duplicate).

### Test notes

- Simulate an enumeration throw for one HEAD delta, then a subsequent clean delta, and assert the dropped commit's `planctl-commit-changed` is re-emitted (head-cache did not skip it).
- Assert the divergence-wedge window re-enumerates on clear.

## Acceptance

- [ ] The silence mode is confirmed from the live logs and named in the Done summary
- [ ] A transient `enumerateCommitsInDelta` failure no longer permanently drops the commit — the next HEAD-oid change re-enumerates and re-emits `planctl-commit-changed`
- [ ] Persistent-failure spin is bounded (retry cap / advance-with-loud-log), not an infinite re-enumeration loop
- [ ] Divergence-wedge commits re-enumerate once the wedge clears
- [ ] Producer-only contract intact (a failure logs+continues, never wedges the worker); no reducer/schema change
- [ ] `bun test test/git-worker.test.ts` passes including the new re-enumeration test

## Done summary
Confirmed silence mode from live server.stderr: 10 'backstop (heartbeat) emitted' lines for keeper .planctl close commits (fn-702..fn-705) with ZERO 'commit enumeration failed' lines, plus 2 'HEAD divergence for /Users/mike/code/keeper' suppression events — the commit channel went silent and the 60s heartbeat had to recover. Fixed the unconditional lastHeadOidByRoot advance: gated it on enumeration success (new pure decideHeadCacheAdvance helper) so a transient enumerateCommitsInDelta throw HOLDS the head cache and re-enumerates/re-emits planctl-commit-changed on the next HEAD-oid observation. Bounded the spin with COMMIT_ENUM_MAX_RETRIES (5): a permanently corrupt range force-advances with a loud backstop alarm rather than hot-looping. Verified the divergence-wedge path already holds the cache (early return at :1865 before the advance) and re-enumerates the full window on clear — added a test pinning it. Producer-only contract intact (log+continue), no reducer/schema change. 101 git-worker + 80 plan-worker tests pass.
## Evidence
