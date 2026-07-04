## Overview

A keeper-initiated epic-base merge that conflicts can leave the shared primary
checkout mid-merge (MERGE_HEAD + unresolved paths), and today the readiness
probe folds that state into the generic "dirty" verdict: the recover/finalize
passes quietly skip-and-retry forever, every plan-state commit board-wide fails
with "cannot do a partial commit during a merge", and no operator signal fires.
This epic makes the machinery classify mid-merge distinctly, self-heal residue
it provably owns, and escalate any sustained wedge into a visible distress row.

## Quick commands

- `bun test test/worktree-git.test.ts test/autopilot-worker.test.ts test/dispatch-failure-key.test.ts` — the touched fast-tier suites
- `rg -a "mid-merge" src/ | head` — the new classification threaded through the producer chain
- `bun scripts/lint-claude-md.ts` — invariant-prose edit stays inside the size gate

## Acceptance

- [ ] A mid-merge shared checkout is classified distinctly from generic dirt, with ownership attribution, and the recover/finalize dispatch-failure reasons name it
- [ ] Keeper-owned merge residue self-heals (bounded guarded abort) without human action; foreign or ambiguous residue is never aborted
- [ ] A wedge persisting past a short grace watermark mints a visible per-repo distress row that level-clears when the checkout recovers
- [ ] A failed or timed-out merge abort surfaces in telemetry instead of vanishing

## Early proof point

Task that proves the approach: ordinal 1 (the MERGE_HEAD-before-dirty reorder of
`mergeReadiness` plus attribution). If reordering the deliberate dirty-first
probe breaks existing consumers in unexpected ways, revisit whether the
classification should be a sibling probe the callers invoke instead of a new
readiness kind.

## References

- Incident forensics: dispatch_failures events 4740745/4740793 (conflict rows minted), 4743234..4743915 (reason degraded to dirty-checkout while wedged), 4743980/4744732 (clears after hand-resolution); wedge window 20:32-20:54, hand-resolved as merge commit 0c15abd7
- `fn-1103-multi-harness-agent-maturity` (overlap) — its task .11 edits src/daemon.ts and .9 edits CLAUDE.md; fn-1103 drains before this epic dispatches, so the shared files are rebase targets, not live collisions
- git-merge docs (--abort == reset --merge; MERGE_AUTOSTASH; may fail to reconstruct pre-merge uncommitted changes); git-worktree docs (pseudo-refs are per-worktree — probe via rev-parse, never file paths); git wt-status.c (canonical in-progress-state classifier precedence)

## Docs gaps

- **CLAUDE.md**: revise the Autopilot clause "finalize instead DEGRADES a dirty/off-branch shared-checkout ... into a non-sticky retry skip that mints no sticky row at all" in place — carve out the mid-merge subcase and state the classification + self-heal + sustained-escalation contract; keep lint-claude-md green

## Best practices

- **Worktree-aware probing:** detect in-progress state via `git rev-parse --verify --quiet MERGE_HEAD` — pseudo-refs are per-worktree; never stat `.git/MERGE_HEAD` by path
- **Sole-ownership attribution:** abort only when the branch-set at the MERGE_HEAD sha is non-empty and entirely `keeper/epic/*` (`git for-each-ref --points-at`); any foreign branch, or none, refuses — MERGE_MSG is corroboration only
- **Abort hazard:** `git merge --abort` behaves as `git reset --merge` — it can fail, and can be unable to reconstruct pre-merge uncommitted changes; a present MERGE_AUTOSTASH refuses the auto-abort
- **index.lock:** a stale lock blocks the abort itself — detect and name it as its own wedge detail, never remove it blindly
