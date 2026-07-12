## Description

**Size:** M
**Files:** src/autopilot-worker.ts, test/autopilot-worker.test.ts, test/worktree-git-catchup-realgit.slow.test.ts

### Approach

Add a SEPARATE producer pass (a recover/finalize SIBLING — NOT inside the read-only snapshot
probe) that consumes `.2`'s `baseDriftEntries` and, for each drifted lane that is QUIESCENT
(clean tree + no live worker via `liveAttributedDirtyByWorktree` :7430 + `mergeReadiness`/
`losslessPremergeClean`), MERGES the local default INTO the lane's base worktree — default→base,
the OPPOSITE direction from finalize's base→default, into the lane's OWN worktree, never the
shared checkout — via `mergeBranchInto` (:1554, flock-guarded, ancestor-skip, conflict-abort).
Rate-limit via a git-derived cooldown (skip if the base's last refresh-merge `%ct` is within the
cooldown) so a fast-moving default cannot trigger per-cycle churn. On `mergeBranchInto` conflict,
route to the EXISTING `worktree-merge-conflict` → resolver → deconflict chain (no new code) —
surfacing the drift conflict early, on the isolated delta, at a quiescent point, is the intended
win. Lock/local timeout is a non-sticky retry-skip minting no distress (DEGRADE-to-retry
discipline); defer on any inconclusive input. Verify the added merge commit does NOT turn
finalize's base→default into a non-ff (`classifyPremergeRedundancy` :918).

### Investigation targets

*Verify before relying — the repo moves.*

**Required:**
- src/autopilot-worker.ts:4261-4600 — `finalizeEpic` (sibling-pass shape; base→default direction to invert)
- src/autopilot-worker.ts:7048-7091, :8271 — distress tracker mint/level-clear + consumption
- src/autopilot-worker.ts:7430 — `liveAttributedDirtyByWorktree` (the live-worker quiescence signal)
- src/worktree-git.ts:1554 `mergeBranchInto`, :767 `mergeReadiness`, :1107 `losslessPremergeClean`, :918 `classifyPremergeRedundancy`

**Optional:**
- docs/adr/0016 (two-tree catch-up), docs/adr/0008 (plumbing merge direction / why merges avoid the shared checkout)

### Risks

Refreshing mid-lane-work can MANUFACTURE the conflict it prevents — the quiescence gate is load-bearing (the flock is commit-only, it does not protect an uncommitted dirty tree). NEVER rebase/force-push the base (dependent lanes build on it). Relationship to `computeStaleBaseLaneEntries`: a default→base refresh REMEDIATES the very drift stale-base only SURFACES — ensure the two do not double-escalate.

### Test notes

Faked `WorktreeGitRunner`: drifted+quiescent → one default→base merge; dirty/live-worker lane → deferred, no merge, no distress; conflict → existing escalation chain; within cooldown → skipped. A slow real-git variant exercises the actual merge.

## Acceptance

- [ ] When enabled, a producer pass merges the local default into a drifted, QUIESCENT lane's own base worktree (default→base) — never the shared checkout, never a rebase.
- [ ] A non-quiescent lane (dirty tree or live worker) is deferred with no merge and no distress row.
- [ ] A refresh-merge conflict routes to the existing worktree-merge-conflict/resolver/deconflict chain; lock/timeout is a non-sticky retry-skip.
- [ ] Refresh is rate-limited so a fast-moving default cannot trigger a merge every cycle; the refresh commit does not turn finalize into a non-fast-forward.

## Done summary

## Evidence
