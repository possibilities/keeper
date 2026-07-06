## Description

**Size:** M
**Files:** src/autopilot-worker.ts, src/worktree-git.ts, cli/commit-work.ts, test/autopilot-worker.test.ts, test/worktree-git.test.ts, docs/adr/

### Approach

Replace the working-tree `git merge --no-edit` at the heart of the ONE shared
helper `mergeLaneBaseIntoDefault` with a working-tree-free plumbing pipeline, so
BOTH callers (finalize + recover pass-2) are fixed by one change. Keep the
helper's existing scaffolding intact: the two-stage local+origin ahead-check
(idempotent re-run -> `not-ahead` no-op), the turn-key + proven-non-ff push
prechecks, `pushDefaultToOrigin` (the HEAD-safety + push-only + origin-containment
gating, shared with recover pass-3), and the caller-neutral `MergeLaneResult`
union. Excise only the working-tree merge and the shared-checkout preconditions
(`mergeReadiness` for the base merge — it stays LIVE for `losslessPremergeClean`,
do not delete it).

New pipeline inside the helper:
1. Feature-detect `git merge-tree --write-tree` (git >= 2.38); if absent, a
   distinct transient skip arm (never a boot fatalExit — worktree mode is
   default-off). Both target repos are 2.50.1 today.
2. Short-circuit already-up-to-date (base is ancestor of default) and pure
   fast-forward (default is ancestor of base -> advance the ref straight to the
   base tip via CAS, NO commit-tree) BEFORE any merge-tree; feeding an FF tree to
   commit-tree mints a bogus 2-parent merge.
3. Real merge: `git merge-tree --write-tree <default-tip> <base-tip>`. Drive
   conflict off the EXIT CODE (0 clean, 1 conflict -> the EXISTING sticky conflict
   escalation, >1 hard error -> a failure arm); do NOT use `--stdin` mode; parse +
   hex-validate the tree OID from stdout line 1.
4. `git commit-tree <tree> -p <default-tip> -p <base-tip> -m <msg>` with ALL FOUR
   GIT_AUTHOR/COMMITTER NAME+EMAIL set to keeper's existing auto-commit identity
   and GIT_AUTHOR_DATE/GIT_COMMITTER_DATE pinned deterministically (base-tip
   committer date, never wall-clock) so a crash-retry re-derives the SAME commit
   OID and the CAS is a clean no-op.
5. Compare-and-swap `git update-ref refs/heads/<default> <newcommit> <old-default-tip>`
   — a stale `<old>` (a concurrent local advance) is a DISTINCT transient
   retry-skip arm (model like `lock-timeout`, never a sticky conflict, never a
   strand). Then push via the existing `pushDefaultToOrigin`.

All new git calls go through the injected `run: WorktreeGitRunner` with
GIT_LOCAL_TIMEOUT_MS + the existing gitExec seam (124 timeout / 127 spawn-fail
sentinels, GIT_DISCOVERY_ENV_VARS stripped — do NOT reintroduce GIT_DIR); reuse
the push env flags (GIT_TERMINAL_PROMPT=0, batch-mode GIT_SSH_COMMAND) verbatim;
`--end-of-options` + ref-name validation on the plumbing args.

Wire the new result kinds (`cas-stale`, the git-version arm, any hard-error arm)
into BOTH switches, and ADD the missing exhaustiveness `never` guard to the
finalize switch (recover pass-2 already has one) so an unhandled kind can NEVER
fall through to lane teardown on an unmerged base.

Best-effort working-tree resync (decision B): AFTER the merge lands, if the
shared checkout is on the default branch AND clean, fast-forward its working tree
to carry the merged commit; on dirty/off-branch/any error, skip SILENTLY — this
is cosmetic and must NEVER block or retry the finalize (the merge already landed).

Re-pin the commit-work merge lock to the COMMON git-dir (`--git-common-dir`) so it
still serializes against a `keeper commit-work` run even though the merge no
longer sits in the shared checkout; reconcile the `cli/commit-work.ts` argv-identity
invariant + its comment so neither lies.

Write `docs/adr/<next-number-after-0007>-plumbing-base-default-merge.md` (MADR
shape) recording the decision: working-tree-free plumbing merge to decouple the
daemon from the human's shared checkout; alternatives weighed (detached worktree
-> blocked by two-worktrees-same-branch; keep working-tree merge -> the silent
stall); consequences (no local merge hooks, best-effort resync, flock re-pin).

### Investigation targets

*Verify before relying — file:line planner-verified at authoring time, the repo moves. NOTE: `grep` reads src/autopilot-worker.ts as binary; use `grep -a` or ripgrep.*

**Required** (read before coding):
- src/autopilot-worker.ts:3974 `mergeLaneBaseIntoDefault` — the helper to rewrite; ordered ahead-check(3981-4019)/mergeReadiness(4021)/turn-key(4046)/non-ff(4053)/merge(4059)/push(4088)/recheck(4098-4108)
- src/autopilot-worker.ts:3828 `MergeLaneResult` union — add the new kinds here
- src/autopilot-worker.ts:3625 finalize reason switch (NO never-guard — add it) and :4512 recover switch (:4635 has the never-guard)
- src/autopilot-worker.ts:3903 `pushDefaultToOrigin` + :3915 HEAD==default assertion (reuse; the last shared-checkout coupling — belt-and-suspenders with an explicit refspec)
- src/worktree-git.ts:1492 `mergeBranchInto` (the working-tree merge being replaced) and :548 `isAncestorOf` (FF / up-to-date detection primitive)
- src/worktree-git.ts:337 `commitWorkLockPath` (re-pin to --git-common-dir) and cli/commit-work.ts:577 (the argv-identical lock invariant + comment 574-576 to reconcile)
- src/commit-work/git-exec.ts — the `GitRunner`/`gitExec` seam, `buildGitEnv`, the 124/127 sentinels (all new plumbing calls ride this)
- test/autopilot-worker.test.ts:8481 `makeRecoveryGit` fake + :7342 the direct `mergeLaneBaseIntoDefault` unit tests (~15 cases) — extend with merge-tree/commit-tree/update-ref argv branches; assert the merge NO LONGER runs in the shared-checkout cwd

### Risks

- The shared checkout on default (clean OR dirty) desyncs when `update-ref` advances the ref without touching the working tree — decision-B resync covers the idle-clean case; the dirty/off-branch case is the human's to resync (documented).
- `merge-tree --write-tree` is tree-vs-tree: content-conflict detection is equivalent-or-cleaner than porcelain merge, but it structurally cannot see dirty/would-clobber-untracked working-tree state — acceptable here (that state no longer blocks a plumbing merge; `mergeReadiness`/`wouldClobberUntracked` stay live only for the lane pre-merge).
- update-ref CAS success != push success; a post-CAS non-ff push rejection leaves local default ahead of origin and MUST escalate via the existing non-ff/push-unconfirmed handling, never fetch/rebase/force.
- A new `MergeLaneResult` kind unhandled in the finalize switch silently strands + tears down an unmerged base — the added never-guard is the safety.

### Test notes

Pure in-process fast tier only (injected `run`, no real git). Extend `makeRecoveryGit` + the direct unit tests to model: clean FF (update-ref straight to base tip, no commit-tree), real merge (merge-tree->commit-tree->update-ref CAS->push), a DIRTY/off-default shared checkout still landing the merge (the regression), CAS-stale `<old>` -> transient skip, merge-tree exit 1 -> existing sticky conflict, crash-retry idempotency (same OID -> not-ahead no-op), and assert no `merge --no-edit` runs in the shared-checkout cwd.

## Acceptance

- [ ] The base->default merge lands and pushes with NO working-tree `git merge`, and it still lands while the shared checkout is dirty or on a non-default branch (the regression that motivated this)
- [ ] A pure fast-forward advances default via CAS update-ref without minting a 2-parent merge commit; a real merge mints one via commit-tree; already-up-to-date is a no-op
- [ ] A concurrent default advance (CAS `<old>` mismatch) yields a distinct transient retry-skip, not a sticky conflict or a strand; a merge-tree conflict (exit 1) still routes to the existing sticky conflict escalation
- [ ] The finalize result switch has an exhaustiveness guard so no result kind can fall through to lane teardown on an unmerged base
- [ ] When the shared checkout is idle-clean-on-default, its working tree ends up carrying the merged commit; when dirty/off-branch the resync is skipped without blocking the merge
- [ ] The merge lock still serializes against `keeper commit-work` (re-pinned to the common git-dir) and the cli/commit-work argv-identity invariant/comment is reconciled
- [ ] A crash-retry re-derives the same merge commit OID (pinned identity + dates)
- [ ] docs/adr records the decision, alternatives, and consequences
- [ ] `bun test test/autopilot-worker.test.ts test/worktree-git.test.ts` is green

## Done summary

## Evidence
