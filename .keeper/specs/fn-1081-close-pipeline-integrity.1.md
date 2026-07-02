## Description

**Size:** M
**Files:** plugins/plan/src/vcs.ts, plugins/plan/src/commit_lookup.ts, plugins/plan/src/verbs/close_preflight.ts, plugins/plan/test/fake-vcs.ts, plugins/plan/test/saga-close-preflight.test.ts, plugins/plan/test/src-git-lookup.test.ts

### Approach

Teach the trailer scan to see epic-lane commits, per repo: trailerCommitShas gains an
optional ref parameter; findCommitGroups, when scanning for an epic close, first probes
each repo for the deterministic lane branch (`git rev-parse --verify keeper/epic/<epic_id>`
via a new PlanVcs method) — present: scan that ref (plain ref argument to git log; NEVER
--not main, NEVER --branches/--all); absent: scan HEAD exactly as today. This is a no-op for
single-repo/non-worktree closes and self-heals post-finalize re-runs (lane pruned → HEAD
reaches the merged commits). Re-derive the lane-branch prefix as a local constant in the
plan plugin with a parity test pinning it to keeper's KEEPER_EPIC_BRANCH_PREFIX value —
never import src/worktree-git.ts. Model the ref-scoped scan and the rev-parse probe in
fakeVcs so the fast tier drives both branches.

### Investigation targets

**Required** (read before coding):
- plugins/plan/src/vcs.ts:285-306 — current scan; add the ref plumb here
- plugins/plan/src/commit_lookup.ts:59-131 — resolveRepoSet + per-repo loop; the probe-then-scan lands in this loop
- plugins/plan/src/verbs/close_preflight.ts:124-170 — caller; epic_id is in scope for the lane-ref derivation
- src/reconcile-core.ts:787-816 — VERIFY the multi-repo clustering path uses the identical keeper/epic/<epic_id> base-branch name in secondary repos (baseBranch derivation); if a secondary repo uses a different name, the fallback silently reintroduces the halt — surface it, don't guess
- plugins/plan/test/fake-vcs.ts:323 fakeSourceCommit — the seeding helper to extend

### Risks

- trailerCommitShas is shared by find-task-commit — the ref parameter must default to today's HEAD behavior so other callers are untouched.
- A missing-ref git error must fold to the HEAD fallback, never an empty group (an empty group silently drops the repo and re-triggers the audit halt).

### Test notes

Plan suite via fakeVcs: lane-present (lane-only commit found), lane-absent (HEAD fallback,
byte-identical to today), missing-ref error path, multi-repo mixed (primary has lane,
secondary doesn't). Prefix parity test against the literal string.

## Acceptance

- [ ] Lane-only primary-repo commits appear in commit_groups for a worktree epic; single-repo behavior unchanged
- [ ] Missing/invalid lane ref falls back to HEAD, never drops a repo
- [ ] Prefix parity test pins the local constant to keeper's value; no worktree-git import in plan src
- [ ] Secondary-repo lane naming verified and handled (or surfaced as a typed finding in the Done summary)

## Done summary

## Evidence
