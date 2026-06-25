## Description

**Size:** S
**Files:** src/compaction.ts, test/refold-equivalence.test.ts, test/tmux-focus-compaction.test.ts (new)

### Approach

Reclaim the cold tail of `TmuxClientFocusSnapshot` events (the producer already keeps idle volume at
zero, but active navigation logs a slow trickle). Add a SEPARATELY-NAMED live-only physical-delete
predicate — do NOT widen `NOOP_SNAPSHOT_DELETE_PREDICATE` (compaction.ts:230), whose guarding test
(refold-equivalence.test.ts:1940) asserts it matches EXACTLY the three retired no-op-arm classes and
would fail if a fourth were added. The new predicate deletes old `TmuxClientFocusSnapshot` rows; because
the projection is live-only and the worker re-derives it on connect, deleting them changes no
deterministic projection. Pin the new predicate with its OWN SAFE (deleting old focus rows leaves every
deterministic projection byte-identical) + NECESSARY (the rows are a deletable cold tail) test pair.

### Investigation targets

**Required** (read before coding):
- src/compaction.ts:230 — `NOOP_SNAPSHOT_DELETE_PREDICATE` and the surrounding shed-class machinery (the pattern to clone into a new, separately-named predicate).
- test/refold-equivalence.test.ts:1940 — the test pinning the three classes (must STAY green / untouched by the new predicate); :2001 — the broad-shed-class exclusion assertion.

### Risks

- Accidentally widening the pinned predicate fails the guard test — the new predicate must be a distinct symbol.
- The SAFE/NECESSARY pair must actually prove live-only isolation (re-fold byte-identity for deterministic projections after deleting focus rows).

### Test notes

New SAFE+NECESSARY test pair for the focus predicate; assert the existing three-class pinning test is
unchanged and green. `bun run test:full` (touches compaction + re-fold).

## Acceptance

- [ ] A new, separately-named live-only delete predicate reclaims cold `TmuxClientFocusSnapshot` rows; `NOOP_SNAPSHOT_DELETE_PREDICATE` and its three-class pinning test are untouched.
- [ ] A SAFE test proves deterministic projections re-fold byte-identical after the focus rows are deleted; a NECESSARY test proves the rows are eligible.

## Done summary
Added separately-named TMUX_FOCUS_DELETE_PREDICATE + deleteColdTmuxFocusRows reclaiming the cold TmuxClientFocusSnapshot tail (wired into the daemon retention pass), leaving NOOP_SNAPSHOT_DELETE_PREDICATE and its three-class pinning test untouched. New SAFE+NECESSARY pair proves deterministic projections re-fold byte-identical after the live-only focus rows are deleted, and that the rows are a deletable cold tail.
## Evidence
