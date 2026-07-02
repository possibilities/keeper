## Overview

The close pipeline has three verified integrity holes: the close-preflight commit scan is
blind to epic-lane commits in the primary repo (HEAD-only scan at the main checkout), a
stopped-dead job whose launcher pane survives silently occupies the dispatch slot with zero
operator-visible signal, and manual close dispatch neither runs in the lane nor excludes a
concurrent reconciler-minted closer. Settled decisions: per-repo lane-ref scan with HEAD
fallback (plain lane ref, never --not main, never --branches/--all); zombie handling is
visibility-first with auto-reclaim only under the narrow provable dead-claude criterion;
claim-time exclusivity owns duplicate-close correctness (fail-loud loser) — the manual-spawn
boot-window race is accepted as a wasted session boot, documented, because the CLI has no
sanctioned write path to pre-announce a spawn.

## Quick commands

- Multi-repo worktree epic with lane-only primary commits: `keeper plan close-preflight <epic>` brief carries the primary-repo commit group (today: missing)
- Kill a closer's claude, leave the pane: board shows a visible occupancy reason within one cycle (today: silent)

## Acceptance

- [ ] close-preflight sees lane-only commits per repo (lane ref when present, HEAD fallback), single-repo/non-worktree closes byte-identical behavior
- [ ] A stopped-dead job occupying a slot mints a visible dispatch_failure reason through the change-gate; auto-reclaim fires only on the provable dead-claude criterion; auto-clear scoped to the new reason, never the close::<epic> conflict key
- [ ] Second close claimant fails loud; manual dispatch close:: resolves the epic lane dir; race-guard refusals name warm-resume/reclaim before --force
- [ ] Full fast suite green; fakeVcs models the ref-scoped scan

## Early proof point

Task that proves the approach: `.1` (lane-aware scan). If the per-repo lane-ref gate proves
unsound for secondary repos, fall back to scanning the lane WORKTREE PATH for the primary repo
only and file the secondary-repo case as a bounded finding.

## References

- plugins/plan/src/verbs/close_preflight.ts:124-170 — scan entry; :129-136 the contextForRoot precedent this extends
- plugins/plan/src/vcs.ts:285-306 trailerCommitShas (no-ref today); plugins/plan/src/commit_lookup.ts:83-131
- src/reconcile-core.ts:945-982 isOccupyingJob/isStoppedJobLive; src/autopilot-worker.ts:3831-3844 livePaneIds probe; :922-945 createDispatchFailedGate (any new emit routes through it)
- cli/dispatch.ts:205-263 resolvePlanCwd; :276-308 race guard; :289-301 refusal texts
- Lane branch vocabulary: keeper/epic/<epic_id> (KEEPER_EPIC_BRANCH_PREFIX, src/worktree-git.ts:693) — plan verbs re-derive as a local constant with a parity test, never import the module
- Evidence: inventory items 8/9/14/15/16 in the session failure inventory; fn-1073 halted 3x on the identical lane-blind finding

## Docs gaps

- **plugins/keeper/skills/dispatch/SKILL.md**: race-guard refusal example lines + exit-taxonomy row must match the new wording
- **plugins/keeper/skills/autopilot/SKILL.md**: dispatch_failure kind enumeration (two spots) gains the occupancy reason
- **plugins/plan/README.md**: close-preflight "confirms" sentence gains the lane-visibility clause
- **docs/problem-codes.md**: only if a new reason surfaces on a CLI envelope; daemon-internal reasons stay out

## Best practices

- **Scan scope:** plain lane ref per repo; never --not main (drops merged commits, breaks re-runs), never --branches/--all (stale unpruned worktree refs + cherry-pick false positives)
- **Liveness reads stay producer-side:** pane/occupancy probes live in loadReconcileSnapshot, never in a fold (re-fold determinism)
- **Notify-once by column, clear-on-resolution immediate:** reuse the change-gate; no second latch table
