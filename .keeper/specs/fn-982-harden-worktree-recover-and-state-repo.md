## Overview

Round 2 of worktree-mode hardening (after fn-979 fixed the phantom/missing-source pre-merge case).
Two bugs jammed the board on the first real worktree run: (1) the recover pass sticky-failed on a
stale prior-session lane branch and the failure could never auto-clear (its epic was reaped, so
`retry_dispatch` had no row) → permanent un-clearable jam; (2) plan-state reconcile resolved to the
*worktree* HEAD instead of the primary repo when `KEEPER_PLAN_WORKTREE` was set, false-positiving
`state_uncommitted` and stalling the close. End state: a genuine merge problem **fails loud and blocks
only its own lane** (a human intervenes — that's fine), but it **auto-clears the moment the git is
fixed**; done epics leave no stale branch; and plan-state always resolves to the primary repo.

## Quick commands

- `bun test test/autopilot-worker.test.ts plugins/plan/test/saga-reconcile.test.ts plugins/plan/test/saga-worker-resume.test.ts plugins/plan/test/saga-validate-resolve.test.ts`
- `ty`

## Acceptance

- [ ] A genuine recover merge conflict still fails LOUD and blocks only that epic (per-key `failedKeys`), never the whole board
- [ ] That failure AUTO-CLEARS on the next recover cycle once the underlying git is resolved (branch deleted or now merges) — no `retry_dispatch`
- [ ] Auto-clear never dismisses a non-recover close-sink failure that shares the `close::<epic>` key
- [ ] A successfully-closed epic leaves NO lane branch behind (no fn-973-style pileup)
- [ ] plan-state reconcile/resolve/resume resolve to the PRIMARY repo even with `KEEPER_PLAN_WORKTREE` set; lane `target_repo` still follows the worktree
- [ ] worktree mode can land an epic end-to-end without jamming

## Early proof point

Task `.1` (recover robustness) is the load-bearing fix — the auto-clear + prune kill the jam class.
If it can't be expressed cleanly on the fake-git seam, fall back to splitting auto-clear from prune.

## References

- fn-979 (worktree phantom-lane finalize fix, DONE) — fixed missing-source pre-merge; this is the RECOVER path + plan-STATE repo, distinct failures
- fn-978 (lane-target-repo resolution, DONE) — fixed the producer geometry but missed the 3 plan-verb consumers (Task 2)
- This session's post-mortem: stale-worktree recover-conflict sticky jam + KEEPER_PLAN_WORKTREE state-repo bug

## Docs gaps

- **plugins/plan/CLAUDE.md** (## Environment variables, KEEPER_PLAN_WORKTREE ~:46): narrow "governs target/primary/state for resolve-task/worker-resume/reconcile" to **target_repo only**
- **README.md** (## Architecture worktree-mode recovery ~:3212): recover skips/auto-clears resolved lanes; a recover conflict blocks its lane loud but is level-triggered (not a sticky board-jam)
- **src/agent/.../runtime_status.ts** + **keeper/CLAUDE.md**: comments/invariant for the narrowed override + the recover-pass level-triggered rule (only if an agent would otherwise get it wrong)

## Best practices

- **Don't retry a merge conflict (retry-storm anti-pattern):** a conflict is a permanent state for the current refs — surface it, block the lane, let a human resolve; auto-clear when the refs change [Azure retry-storm]
- **Level-triggered failure clearing:** re-derive "is this lane still blocked?" from live git each cycle and clear the durable failure row when resolved, rather than requiring a manual retry [controller-runtime reconcile]
- **Git is the recovery authority:** recover by branch state, not a time window — never silently drop a done-but-unmerged lane by recency
