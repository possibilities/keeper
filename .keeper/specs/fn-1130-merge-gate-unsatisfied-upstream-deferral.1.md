## Description

**Size:** S
**Files:** src/autopilot-worker.ts, test/autopilot-worker.test.ts, CLAUDE.md, CONTEXT.md

### Approach

Purely additive branch in the merge-gate probe's per-dep loop: a dep in the blocked-incomplete state whose resolved upstream has a worktree lane in the same resolved repo marks that (epic, repo) deferred immediately — no git probe (an open upstream is trivially not-yet-contained), reusing the existing same-repo lane test and preserving the union-per-repo short-circuit. Dangling, disabled, reaped, cross-repo, and no-lane-in-repo upstreams stay not-gating exactly as today; the satisfied path (ancestry probe, inconclusive-defers, absent-implies-merged) stays byte-identical. The deferral remains ephemeral per-cycle producer data consumed by pure reconcile — no dispatch_failures row, no fold, no lane-rebase machinery, and the pure consumers need no change. Update the probe's doc comment and the root CLAUDE.md merge-gate clause (revise in place, forward-facing, lint green); touch the CONTEXT.md Merge-gate vocabulary entry only if its wording no longer holds.

### Investigation targets

*Verify before relying — planner-verified file:line at authoring time, but the repo moves. Both files need `grep -a` (a stray byte reads as binary to plain grep).*

**Required** (read before coding):
- src/autopilot-worker.ts:1435-1579 — computeDeferredEpicIds, the single function to change; the per-dep loop :1509-1565 currently continues on any non-satisfied state at :1513-1515 (the new branch's insertion point); not-gating skips :1516-1530 must keep folding to skip for everything except the same-repo-lane blocked-incomplete case
- src/autopilot-worker.ts:584-597 hasWorktreeLaneInRepo + :565-575 worktreeLaneRepoDirs — reuse unchanged
- src/types.ts:971-989 — ResolvedEpicDep tri-state (satisfied | blocked-incomplete | dangling); blocked-incomplete is the exact signal, already the loop variable
- src/autopilot-worker.ts:1333-1357 — classifyWorktreeRepos classifies every epic including open ones, so worktreeRepoByEpicId already covers open upstreams: no new snapshot input
- test/autopilot-worker.test.ts:11451-11472 — the test to SPLIT: :11463 asserts a blocked-incomplete same-repo upstream does NOT defer (inverted by this change); keep disabled/reaped/dangling as not-gating, add positive coverage (blocked same-repo-lane defers; blocked cross-repo does not; blocked upstream with no lane in the repo does not)
- src/autopilot-worker.ts:1388-1434 — the gate's doc comment to revise

**Optional** (reference as needed):
- test/autopilot-worker.test.ts:11156-11473 merge-gate suite + fixtures (satisfiedEpicDep :11162, classifyIdentity :11174, gateGit :11193, clusterGit :11239); :12116-12160 pure-consumer tests (unchanged)
- src/reconcile-core.ts:1544-1587, :1708-1713 — pure consumers of deferredEpicIds (no change needed)
- Root CLAUDE.md Autopilot merge-gate clause — the "every satisfied SAME-RESOLVED-REPO upstream" wording to revise in place

## Acceptance

- [ ] In worktree mode, a dependent epic's lane is never cut in a repo where a blocked-incomplete upstream epic resolves to a same-repo worktree lane — deferred probe-free that cycle, and cut normally once the upstream is satisfied and merged
- [ ] Dangling, disabled, reaped, cross-repo, and no-lane upstreams still never gate, and the satisfied-upstream path (ancestry probe, inconclusive-defers, absent-implies-merged) behaves byte-identically, all pinned by the updated merge-gate suite
- [ ] The deferral stays ephemeral per-cycle producer data: no dispatch_failures row, no fold, no pure-consumer change
- [ ] The merge-gate documentation (probe doc comment + root CLAUDE.md clause) reads true forward-facing with the CLAUDE.md lint green

## Done summary
Extended computeDeferredEpicIds so a blocked-incomplete (still-open) upstream that cut a same-resolved-repo worktree lane defers the dependent's lane cut probe-free, preventing a stale-base fork; satisfied ancestry/inconclusive/absent paths and cross-repo/no-lane not-gating stay byte-identical, pinned by new fn-1130 merge-gate tests.
## Evidence
