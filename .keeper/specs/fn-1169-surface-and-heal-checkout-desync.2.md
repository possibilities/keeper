## Description

**Size:** M
**Files:** src/autopilot-worker.ts, test/autopilot-worker.test.ts, test/worktree-git-catchup-realgit.slow.test.ts, docs/adr/

### Approach

Rewrite decision-B (the ~12-line post-ref-advance resync block inside mergeLaneBaseIntoDefault) from idle-clean-gated `reset --hard` to a stale-aware catch-up: gate on current branch == default AND no `.git/MERGE_HEAD`, then `git update-index -q --really-refresh` followed by `git read-tree -m -u <preMergeTip> <newTip>` — both trees passed explicitly (the pre-merge tip is already in hand as the CAS `<old>`/`defaultTip`; post-CAS HEAD already names the new tip so HEAD is the wrong `$H`). Stale paths advance, humanly-edited paths carry forward, and one path that is both upstream-changed and locally-edited aborts the ENTIRE op with no writes — that abort is the normal safe outcome, leaving task 1's desync row standing as the honest signal. Everything stays inside the already-held common-dir flock and the existing try/finally; every subprocess failure is swallowed (the merge result remains `merged` unconditionally — the ref advance already landed and the catch-up is strictly best-effort). The `MergeLaneResult` union and both consuming switches stay untouched. On success the next reconcile cycle observes the checkout carrying the tip and level-clears the row. Never use `checkout <tree> -- <paths>`, `checkout -f`, `--reset`, or hand-written blobs; route all writes through read-tree so git's symlink/path-traversal protections hold.

Lands the decision record: a new ADR (next free number, descriptive slug) stating the resync is now stale-aware and its skip is board-visible, superseding in part ADR 0008's decision-B consequence ("skipped silently, cosmetic"); 0008 gains the supersession pointer. ADR shape: Status/Context/Decision/Alternatives considered/Consequences; ADR numbers are reused across slugs, so pick the next genuinely free number.

Grep caution: src/autopilot-worker.ts contains a NUL byte — use `rg -a`.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/autopilot-worker.ts:4441-4483 — the decision-B block to rewrite (idle-clean gate ~4447-4450, reset --hard ~4478-4483, lock held ~4435-4486)
- src/autopilot-worker.ts:4317 and ~4461 — defaultTip resolution and its use as the CAS `<old>`: this IS the preMergeTip for the two-tree call
- test/autopilot-worker.test.ts:7342-7567 — makeMergeGit scripted fake; the three decision-B assertions that WILL break and must be rewritten: idle-clean resync ~7786-7800 (reset --hard → refresh + read-tree), dirty-skip ~7741-7761 (no reset → attempts catch-up, aborts on colliding edit), off-branch ~7763-7784 (unchanged)
- docs/adr/0008-plumbing-base-default-merge.md — decision-B consequence lines to supersede in part

**Optional** (reference as needed):
- test/worktree-git-premerge-realgit.slow.test.ts — the KEEPER_RUN_SLOW real-git harness pattern (git init/commit/worktree-add inline) to mirror for the new slow test

### Risks

- read-tree two-tree semantics differ subtly from the fake's string-matching — the slow real-git test is the ground truth; the fake only asserts argv shapes
- A linked-worktree checkout of default has its own index/HEAD — run the catch-up against the checkout's own worktree dir (the existing decision-B already targets it; preserve that)
- Sparse-checkout skip-worktree paths are intentionally left alone by read-tree — document, don't fight

### Test notes

Fast tier: extend makeMergeGit with update-index/read-tree matches + per-path knobs; assert the exact argv (`read-tree -m -u <old> <new>`), the MERGE_HEAD skip, and that any non-zero exit still returns `merged`. Slow tier (KEEPER_RUN_SLOW): real-git proof that an unrelated local edit is preserved while stale paths advance, and that a colliding edit aborts with zero writes.

## Acceptance

- [ ] After a successful ref advance, an on-default shared checkout with no conflicting local edits carries the new tip at the end of the same merge call: upstream-changed paths advance, locally-edited untouched paths are preserved byte-identical
- [ ] A path both upstream-changed and locally-edited aborts the whole catch-up with no worktree writes; the merge result is still `merged`; the desync row remains standing
- [ ] The catch-up never runs while `.git/MERGE_HEAD` exists or the checkout is off-default, always runs under the common-dir flock, and refreshes the stat cache immediately before read-tree
- [ ] No failure of the catch-up can change the merge outcome, throw, or block the ref advance (best-effort, swallowed-on-error)
- [ ] Fake-git decision-B assertions rewritten and green; a KEEPER_RUN_SLOW real-git test proves both heal-unrelated-edit and abort-on-colliding-edit
- [ ] A new ADR records the stale-aware, board-visible resync decision and ADR 0008 carries a supersession-in-part pointer to it

## Done summary

## Evidence
