## Description

**Size:** S
**Files:** src/autopilot-worker.ts, src/readiness.ts, test/autopilot-worker.test.ts

Generalize the cross-epic merge-gate from whole-epic deferral to per-(epic, repoDir) so a
downstream epic's lane in repo R is held only when a satisfied SAME-RESOLVED-REPO upstream group's
base isn't yet an ancestor of R's local default — while the downstream's OTHER-repo groups proceed.

### Approach

`computeDeferredEpicIds` currently adds the WHOLE epic to `deferred`, cutting its entire lane set.
Make deferral per (epic, repoDir): for each downstream group `B@repoR`, walk B's DIRECT
`resolved_epic_deps`, and for each satisfied upstream whose classification has a group in the SAME
resolved `repoR`, probe that upstream group's base ancestry against `repoR`'s LOCAL default; UNION
semantics (any unmerged same-repo upstream group defers `B@repoR`). A downstream group whose repo
has NO matching upstream group proceeds. Keep it EPHEMERAL + producer-probed once/cycle, minting
NO `dispatch_failures` row, every probe inconclusive/error DEFERS. Same-resolved-repo is decided by
the classification map's `repoDir`, NEVER `dep.cross_project`. Then the READINESS gate consuming
the deferred set must suppress only the DEFERRED GROUP's lane keys (its tasks + its close-sink),
not the whole epic — thread the deferral at group granularity into the reconcile work-row and
close-row suppression.

### Investigation targets

**Required** (read before coding):
- src/autopilot-worker.ts:1939 — `computeDeferredEpicIds` (whole-epic add :2028/:2051/:2062; same-repo via classification map :1912; direct `resolved_epic_deps` walk; absent-base = merged-and-torn-down)
- src/autopilot-worker.ts:1645 — reconcile work-row deferral suppression; :1748 close-row `okToPlan` deferral clause
- src/readiness.ts — the lane-keyed mutex / `rootKeyForRow` (how a group's lane keys are addressed)

**Optional** (reference as needed):
- src/worktree-git.ts — `enumerateEpicLaneBranches`, `isAncestorOf`, `resolveDefaultBranch` (reuse per group)
- README merge-gate section (~3560-3597) — the invariant being generalized (docs in task `.5`)

### Risks

- Merge-order inversion is the hazard this gate prevents (practice-scout `[VERIFIED]`): cutting a
  downstream same-repo lane before the upstream landed on local default builds on a stale base.
  Per-group must not weaken this for the same-repo case while freeing the cross-repo case.
- Suppressing only the deferred GROUP (not the whole epic) requires the readiness consumer to
  address lane keys at group granularity — verify a deferred group's close-sink is also suppressed.

### Test notes

Downstream epic B in repos {r1,r2}, upstream A only in r1 with an unmerged r1 base: assert B's r1
group defers while B's r2 group proceeds. Assert an absent upstream base = merged (proceeds).
Assert inconclusive probe defers. Assert cross-repo upstream never gates.

## Acceptance

- [ ] `computeDeferredEpicIds` defers per (epic, repoDir): only the group whose repo has an unmerged same-resolved-repo upstream group is held
- [ ] A downstream group whose repo has no matching upstream group proceeds; cross-repo upstreams never gate; same-repo decided by classification `repoDir` not `dep.cross_project`
- [ ] The readiness gate suppresses only the deferred group's lane keys (tasks + close-sink), not the whole epic
- [ ] Stays ephemeral, producer-probed once/cycle, mints no `dispatch_failures` row; inconclusive/error defers
- [ ] Tests green

## Done summary

## Evidence
