## Description

**Size:** S
**Files:** src/autopilot-worker.ts, test/autopilot-worker.test.ts

### Approach

Protect an epic that ALREADY has live worktree lanes from being flipped to `disabled` mid-flight — which would strand work on `~/worktrees` lanes while new tasks dispatch on the shared checkout, AND lose the merge-to-default finalize (`attachWorktreeGeometry` builds `worktreeFinalize` only for `ok`). The likelier trigger is not a marker appearing mid-epic but a TRANSIENT probe error (fail-closed) flipping a healthy in-flight epic for one cycle.

- Gather a per-epic grandfather predicate producer-side in `loadReconcileSnapshot` (fs/git, never a fold): an epic is grandfathered if its deterministic base worktree dir exists (`existsSync(worktreePathFor(repoDir, baseBranchFor(epicId)))`) OR its `keeper/epic/<id>` branch exists. Both derive from existing producer signals and match the recover scan's notion of a live lane.
- Thread it as a SEPARATE per-epic input into `classifyWorktreeRepos` / `classifyEpicRepo` — the per-toplevel `assessRepo` is memoized by toplevel and never sees the epic id, so grandfather CANNOT live inside it. When `assessRepo` says disabled BUT the epic is grandfathered, keep returning `ok` (with `repoDir`) so its lanes finalize normally.
- disabled->enabled mid-flight: an epic that STARTED serial (no lanes, not grandfathered) stays serial until done — once disabled with in-flight shared-checkout work, later sibling tasks do not start in lanes. Largely falls out of per-cycle classification (a disabled epic provisioned no base worktree dir); confirm with a test.
- Recover sweep: verify `reposForRecovery` (3519-3544) + `worktreeKnownRoots` (3953-3961) — a disabled repo contributes no lanes (correct; none provisioned) and the known-roots scan is a harmless no-op against it; a grandfathered (still-`ok`) epic IS swept and finalizes normally.

### Investigation targets

**Required** (read before coding):
- src/autopilot-worker.ts:1758-1824 (`classifyEpicRepo` — add the grandfather input), 3519-3544 (`reposForRecovery`), 3943-3961 (`loadReconcileSnapshot` signal gathering + `worktreeKnownRoots`)
- src/worktree-plan.ts:130-171 (`baseBranchFor`, `worktreePathFor`) — the deterministic base-lane path/branch for the grandfather signal

**Optional:**
- src/git-toplevel.ts:18-30 (`gitResolveEnv`) — if querying branch existence via git

### Risks

- Grandfather false-NEGATIVE (in-flight epic not detected) -> split-brain / lost work: use a robust signal (dir-exists OR branch-exists), not a fragile one.
- Grandfather false-POSITIVE (a stale leftover lane dir) -> keeps a now-monorepo repo on worktree mode for that one epic; bounded (only affects an epic that already has that dir; the recover sweep eventually cleans a dead epic). Acceptable — note it.
- The grandfather predicate MUST be producer-only; never read inside the pure classify layer or any fold.

### Test notes

- `assessRepo`=disabled + grandfather predicate true -> `classifyEpicRepo` returns `ok` (lanes preserved, finalize intact).
- `assessRepo`=disabled + grandfather false -> `disabled`.
- A transient `probeError` on a grandfathered epic -> still `ok` (no split-brain).
- A synthetic grandfather predicate is injected (no real fs/git in the fast tier).

## Acceptance

- [ ] an epic with live worktree evidence (base worktree dir OR `keeper/epic/<id>` branch) stays `ok` even when its toplevel assesses disabled, INCLUDING on a transient probe error
- [ ] an epic with no live lanes on a disabled toplevel classifies `disabled` and stays serial for its remaining tasks
- [ ] the grandfather predicate is gathered producer-side and injected as a per-epic input (never inside the pure classify layer or a fold)
- [ ] `reposForRecovery` / `worktreeKnownRoots`: a disabled repo contributes no lanes; a grandfathered epic finalizes normally — verified by test
- [ ] the fast tier injects synthetic grandfather + `assessRepo`; no real fs/git

## Done summary
Grandfather in-flight worktree epics against a mid-flight disabled flip: a per-epic predicate (base worktree dir OR keeper/epic/<id> branch exists) gathered producer-side and injected into classifyWorktreeRepos keeps a would-be-disabled epic 'ok' so its live lanes finalize. Added a sync localBranchExists to git-toplevel.
## Evidence
