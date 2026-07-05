## Description

**Size:** M
**Files:** src/autopilot-worker.ts, src/dispatch-failure-key.ts, src/reconcile-core.ts, src/daemon.ts, test/autopilot-worker.test.ts, test/dispatch-failure-key.test.ts

### Approach

Detection: a new pure producer probe SIBLING to the merge-gate probes (never modifying them) that, for each epic with an already-cut lane in a repo, walks its DIRECT satisfied same-resolved-repo upstreams and verdicts whether each upstream's landed work is present in the lane's base — flagging the lane stale when it is definitively missing. Every inconclusive arm (enum failure, ancestry timeout, ambiguous refs) DEFERS to no-flag: a false distress is worse than a late one. The ref test is the design core: upstream lanes are deleted after true merge, and a freshly-cut lane at its fork point is a vacuous ancestor of everything (the landed-work guard precedent solves the inverse problem) — design the ancestry direction deliberately against that precedent before coding. Probe output rides a new optional producer-fed ReconcileSnapshot field, gated on worktree mode, reusing the per-repo resolved toplevels and memoized default-branch/lane enumeration (no extra toplevel spawns).

Surfacing: clone the shared-checkout grace-tracker idiom — pure injected-clock tracker, per-(epic,repoHash) key, exactly-once mint per continuous stale episode past the grace watermark, minted through the generic daemon distress channel under a NEW disjoint id/reason family on the synthetic un-retryable daemon verb (orphan-GC-exempt, pill-mapped, assertNever-enforced), level-cleared off the durable open-rows set when the probe stops reporting the lane stale (re-based or torn down). Change-gate re-emits O(1). The family must be prefix-disjoint from the recover/finalize/shared-wedge/slot/crash-loop families AND from the sibling families fn-1123 and fn-1124 are adding in the same two files. Scope boundary: DEPENDENCY_BLOCKED blocked_reason stays worker-authored prose — no enrichment, no auto-join; this row surfaces the cause so a human connects them.

### Investigation targets

*Verify before relying — planner-verified file:line at authoring time, but the repo moves. NOTE: src/autopilot-worker.ts (5336 lines) reads as binary to plain grep — use `grep -a` or Read.*

**Required** (read before coding):
- src/autopilot-worker.ts:1435 computeDeferredEpicIds — the per-(epic,repoDir) satisfied-upstream probe idiom to mirror (walk, memoization, defer-on-inconclusive); DO NOT modify it
- src/autopilot-worker.ts:1623 computeMergedLaneEntries + its laneCarriesLandedWork vacuous-ancestor guard — the verdict table and the fn-1097 trap the ref test must respect
- src/autopilot-worker.ts:4586-4605 — where deferredEpicIds/landedLaneEntries are produced in loadReconcileSnapshot; the new probe slots here; src/reconcile-core.ts:425,:573,:585 — the sibling optional snapshot fields
- src/autopilot-worker.ts:1118 createSharedCheckoutWedgeTracker + :993 createDispatchFailedGate + :655/:667 emit/clear deps + src/daemon.ts:6296 main handler — the mint/clear wiring to clone
- src/dispatch-failure-key.ts — SHARED_WEDGE_DISTRESS_* constants/predicate template, DISPATCH_FAILURE_DISPLAY_RULES ordering invariant (no prefix of another), assertNever tripwire
- src/worktree-git.ts:1010 enumerateEpicLaneBranches (NOT listEpicLaneBranches), :534 isAncestorOf, :348 resolveDefaultBranch (LOCAL default — what lanes fork from); src/worktree-plan.ts:133,:143,:174,:211 — lane naming + repoDirHash to reuse
- test/autopilot-worker.test.ts:11186 gateGit / :11238 clusterGit fake-git helpers; :11285-11605 + :11611-11945 the probe test matrices to parallel; :12421+ the tracker block to clone; test/dispatch-failure-key.test.ts:168-420 the family-disjointness suite to extend

**Optional** (reference as needed):
- src/daemon.ts:694 parseBlockedCategory + :600 escalatable categories — the DEPENDENCY_BLOCKED boundary (no correlation data exists; stays out of scope)
- src/autopilot-worker.ts:640 emitDispatchCleared — the mintDispatchClearedEvent seam any clear rides

## Acceptance

- [ ] A lane cut before a satisfied same-resolved-repo upstream landed is flagged: exactly one per-(epic,repo) needs_human distress row per continuous episode past the grace watermark, in a new id/reason family disjoint from every existing and sibling-planned family, un-retryable, GC-exempt, pill-rendered
- [ ] The row level-clears once the probe observes the lane re-based past the upstream or torn down, and a fresh stale episode re-mints exactly once, including across a worker restart
- [ ] Every inconclusive probe arm produces no flag and no row; a freshly-cut lane at its fork point is never mis-verdicted stale; the merge-gate's cut-deferral outputs are unchanged across the whole probe test matrix
- [ ] The fast suite is green with probe-matrix, tracker, and family-disjointness coverage extended

## Done summary

## Evidence
