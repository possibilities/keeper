## Overview

In autopilot worktree mode, a dependent epic B (`depends_on_epics:[A]`) can have its
lane branch cut from the default-branch HEAD before upstream epic A's lane has merged
into default — so B builds on a stale upstream. This epic adds a producer-side,
EPHEMERAL, SAME-RESOLVED-REPO git gate that defers cutting B's lane until every
satisfied same-repo upstream is contained in the LOCAL default branch, built on the
armed-eligibility gate template (a per-cycle snapshot probe feeding a no-sticky
pre-dispatch `continue` arm). No durable signal, no schema change; pre-existing stale
lanes are document-and-defer.

## Quick commands

- `bun test test/autopilot-worker.test.ts test/worktree-git.test.ts`
- `bun test`
- `bun scripts/lint-claude-md.ts`

## Acceptance

- [ ] A dependent epic's lane is not cut until its same-resolved-repo upstream is merged into local default; it provisions the cycle after the upstream's finalize merge lands
- [ ] The gate is ephemeral + producer-only (probed in `loadReconcileSnapshot`, read as plain data by pure `reconcile`) and mints NO sticky / `dispatch_failures` row
- [ ] Probe errors/timeouts degrade to DEFER (never a false-satisfied stale fork); same-resolved-repo + multi-upstream-union semantics hold
- [ ] Docs (README / CLAUDE.md / cli help) describe the gate; `bun test` + `lint-claude-md` green

## Early proof point

Task that proves the approach: `.1` (the gate + its unit tests over `fakeAsyncGit` /
`makeSnapshot`). If it fails: the probe / continue-arm seam or the per-lane-keying
assumption (that half-2 is unnecessary) is wrong — re-verify `readiness.ts:1611-1622`
and fall back to also threading the deferred set into the per-root tiebreak.

## References

- Armed-eligibility gate (the template): `src/armed-closure.ts:52`, `src/autopilot-worker.ts:1559`/`1652`, `src/readiness.ts:1611-1622`
- Finalize merge-to-default (the ancestry oracle): `src/autopilot-worker.ts:3041-3043`, `src/worktree-git.ts:909`
- Teardown delete gates (the absent-implies-merged premise): `src/autopilot-worker.ts:2787-2794`, `:3393`, `:3406-3446`
- A parked "keeper await + observability" plan is daisy-chained behind this fix (downstream / reverse dependency, not yet scaffolded) — it owns the durable, subscribable merge signal this epic deliberately does NOT mint.

## Docs gaps

- **README.md** (worktree section ~3285-3344): add the ephemeral cross-epic merge-gate prose; consolidate with fn-1013's worktree-disabled note if it lands first.
- **CLAUDE.md** (worktree bullet line 118): append the ephemeral / never-sticky sub-clause.
- **cli/autopilot.ts** (worktree help ~86-92): note the silent per-cycle deferral.

## Best practices

- **Three-way probe semantics:** exit 0 = ancestor (proceed), exit 1 = not-ancestor (defer), exit >1 / timeout = inconclusive (defer) — never conflate not-ancestor with error. [git-scm]
- **Conservative-degrade-on-error:** in a level-triggered reconciler an inconclusive VCS probe must DEFER (self-heals next cycle), never proceed (a stale fork is permanent). [Chainguard]
- **`--is-ancestor` is invalid after a squash-merge:** keeper is safe only because finalize uses `git merge --no-edit`; the regression test guards against a future switch to `--squash`. [Lucas Oshiro]
