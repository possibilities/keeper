## Overview

Autopilot's worktree-mode fan-in `provision()` merges a completed task's rib
branch into the epic BASE worktree BLIND — no cleanliness probe. A dirty base
worktree makes `git merge` refuse, and the failure becomes a sticky
`dispatch_failures` row keyed `work::<taskId>` (reason `worktree-merge-conflict`)
that no level-clear or escalation ever touches, wedging the dependent task
forever until a human hand-cleans the worktree and `retry_dispatch`es. This epic
extends the landed shared-main-checkout recovery machinery (`mergeReadiness`,
the `worktree-recover*` positive-evidence level-clear, the grace-watermark
distress idiom, DispatchFailed change-gating) to the per-epic LANE pre-merge
path: probe before merging; auto-clean dirt that is provably a lossless leak;
degrade everything else to a non-sticky retry-skip; and escalate a persistent
genuine conflict to a self-clearing needs_human distress row instead of a
sticky-forever dead end.

## Quick commands

- `bun test test/worktree-git.test.ts test/autopilot-worker.test.ts test/dispatch-failure-key.test.ts` — the pure-seam suites gating both tasks
- `bun run test:full:slow` — unlocks the real-git tier proving the blob-equality clean is lossless under `.gitattributes`/`autocrlf`/mode flips
- `keeper query dispatch_failures` — a leaked-but-redundant base no longer leaves a `work::<taskId>` `worktree-merge-conflict` row; a genuine conflict shows a self-clearing `worktree-lane-*` row, not a sticky no-clear one

## Acceptance

- [ ] A base worktree dirtied only by a provably-redundant leak (working-tree content already committed on the incoming rib) auto-cleans and the fan-in merge succeeds, dispatching the dependent task with no human action.
- [ ] No dirty base worktree ever produces a sticky `work::<taskId>` dispatch failure that lacks any level-clear or escalation path.
- [ ] A genuinely-divergent dirty base is never discarded; it degrades to a non-sticky retry-skip and, if it persists past a grace window, mints a needs_human distress row that self-clears once the worktree is resolved.
- [ ] The clean/clear decision is a fresh producer git probe; no fold reads git, the filesystem, or wall-clock, and re-fold determinism is preserved.
- [ ] The full fast suite and the new real-git slow test are green.

## Early proof point

Task that proves the approach: `.1` — reproduce the fn-1106.7 incident shape (base
worktree dirtied with content identical to the incoming rib) in a real-git slow
test and show the fan-in now auto-cleans and merges. If it fails: the blob-equality
"provably redundant" probe is unsound under git's filters — fall back to a
narrower anchor (exact incoming-blob match only, no mode/eol tolerance) and
escalate the rest rather than widening the discard.

## References

- Extends landed epics fn-1114 / fn-1115 (shared-main-checkout mid-merge recovery) and rides atop fn-1117 (worker stash-guard, which prevents the specific leak cause). Not dependencies — landed context.
- Depends on fn-1122-suite-baseline-store: same-file overlap on `src/worktree-git.ts` (fn-1122.2) and `src/daemon.ts` (fn-1122.3); the edge serializes the lanes so fan-in does not collide.
- The aggressive alternative (unconditional `git reset --hard` before every fan-in, justified by the "workers commit, never stash" invariant) is rejected: it silently eats uncommitted work the one time the invariant is false (a killed-mid-edit worker), and the loss is unrecoverable except via `git fsck --lost-found`.

## Docs gaps

- **CLAUDE.md (Autopilot section)**: fold the new lane pre-merge arm and the corrected `work::` clear/escalate semantics into the existing recover/wedge/finalize clause — revise and consolidate, never append (rule #0); keep `bun scripts/lint-claude-md.ts` green.
- **CONTEXT.md ("Worktree and merge")**: add a short entry for the lane pre-merge arm so a worker can disambiguate it from the existing Recover pass / Merge-gate / Fan-in terms; pick a verb other than bare "clean" (the Recover pass Avoid list already claims "cleanup pass").

## Best practices

- **Prove redundancy on the filtered blob, not raw bytes:** `git hash-object --path=<p>` applies `.gitattributes` clean filters + eol normalization exactly as `git add`; a raw `cmp`/`cat-file` compare falsely differs under CRLF/`autocrlf`/smudge-clean. Run `git update-index -q --really-refresh` first to collapse stat-only (mtime) false positives. [practice-scout, VERIFIED]
- **Untracked-blocking dirt is a distinct class:** `git restore` never touches untracked files and there is no committed blob to prove redundancy against — treat it as never-discardable, escalate, don't clean. [practice-scout, VERIFIED]
- **Confine every destructive step:** explicit pathspec after `--`, never a bare `git restore .`; pass attacker-influenceable branch/path names via argv after `--`, parse porcelain with `-z`. [practice-scout, security]
- **Level-triggered + grace watermark, change-gated re-emit:** classify transient (retry-skip) vs genuine (grace→distress); only the transient class auto-retries; never clear-and-retry a genuine conflict every cycle (thrash). Mirrors keeper's shared-checkout-wedge + DispatchFailed change-gate. [practice-scout, VERIFIED]
