## Description

**Size:** M
**Files:** src/autopilot-worker.ts, src/worktree-git.ts, src/dispatch-failure-key.ts, src/needs-human.ts, plugins/plan/test/worktree-finalize-degrade.test.ts, test/autopilot-worker.test.ts

### Approach

Insert a suite gate into finalize ahead of the local default merge: construct the prospective merge result in a scratch worktree (the scratch-provision primitive exists), run the fast suite there, and only on green proceed to the existing merge+push path. Red parks the epic on a new visible sticky family (prefix-disjoint reason + display rule + needs-human classification; mirror the non-fast-forward arm's visible non-retry shape, cleared via the existing retry_dispatch re-arm) — local default never advances on red, so the desync producer sees nothing. A gate that cannot run (scratch provision failure, install drift, timeout) degrades to the existing non-sticky retry-skip shape rather than blocking or silently pushing. Memoize the verdict by merged-tree key so a parked epic's finalize retries do not recompute an unchanged merge. Thread the suite-run as an injected probe on the finalize driver (the isEpicDone precedent) so the fast-tier tests drive decisions purely; the end-to-end red/green paths land in the slow real-git tier.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/autopilot-worker.ts:4118 finalizeEpic, :4169/:4499-4760 mergeLaneBaseIntoDefault + push, :4177-4237 the merge.kind degrade arms (the new arm's home)
- src/worktree-git.ts:1796 provisionScratchWorktree / BASELINE_SCRATCH_PREFIX
- src/dispatch-failure-key.ts — family registration contract (prefix-disjoint, DISPLAY_RULES, assertNever tripwires)
- docs/adr/0008 — the recorded merge-push sequence

**Optional** (reference as needed):
- plugins/plan/test/worktree-finalize-degrade.test.ts — the degrade-arm test harness to extend
- fn-1203's baseline runner wiring — share the suite-run harness where practical, but the merged tree needs its own run (no pre-existing leaf)

### Risks

- Suite duration adds latency to every finalize; the fast tier (~20s) is the ceiling — never the full four-suite gate here.
- Which suites run must cover the merged packages: default to the root fast suite plus the plan suite when the merge touches plugins/plan; state the mapping in code.

### Test notes

Fast tier: injected suite-probe drives green→merge, red→park (sticky minted, no merge call), cannot-run→retry-skip; memoization returns the cached verdict for an unchanged merged-tree key. Slow tier: real-git red merge parks with default untouched.

## Acceptance

- [ ] A red merge-result suite parks the epic on a visible sticky with local default unmoved and no push
- [ ] Green proceeds through the unchanged merge+push path
- [ ] A gate that cannot run degrades to the visible retry-skip class, never a silent push
- [ ] Finalize retries on an unchanged merge reuse the memoized verdict
- [ ] keeper fast suite green; the finalize slow tier passes with the new arms

## Done summary

## Evidence
