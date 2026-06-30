## Description

**Size:** M
**Files:** src/autopilot-worker.ts, src/worktree-git.ts, test/autopilot-worker.test.ts, test/worktree-git.test.ts

### Approach

Producer-side, ephemeral, same-resolved-repo git gate deferring a dependent epic B's
lane-cut until every satisfied same-repo upstream A is contained in the LOCAL default
branch. Two pieces:

(1) **Probe** — in `loadReconcileSnapshot` (the one per-cycle git pass, gated on
`worktreeMode`), after `worktreeRepoByEpicId` is built, compute a
`deferredEpicIds: Set<string>` and add it to the `ReconcileSnapshot` return. For each
epic B whose OWN repo resolution is `ok`, walk B's `resolved_epic_deps`; for each
`state==='satisfied'` dep whose resolved upstream A resolves (via the shared toplevel
memo) to the SAME toplevel as B, probe A's merge state. Defer B if ANY such upstream
is unmerged or inconclusive (union semantics). Reuse the per-cycle
`memoizedNullableGitToplevel` memo; add a per-repo memo for the lane enumeration +
default-branch resolution so N upstreams in one repo don't re-spawn git.

(2) **Gate** — in `reconcile`'s per-row walk, add a no-sticky `continue` arm (mirror
the armed gate at `autopilot-worker.ts:1559` for WORK rows and `:1652` for the CLOSE
row) skipping launches for an epic in `deferredEpicIds`. Place it ABOVE the budget
gate so a deferred epic consumes no global budget. Mint NO `dispatch_failures` row.

**Detection** per same-repo upstream A, keyed off the LOCAL default branch (the same
`gitResolveDefaultBranch` the provision fork-source uses at `autopilot-worker.ts:2700-2704`,
NOT `origin/<default>`): present ∧ `isAncestorOf(keeper/epic/A, localDefault)` →
satisfied; present ∧ ¬ancestor → defer; definitively-absent → satisfied; probe
inconclusive (enumeration or ancestry error / timeout) → defer.

**"Definitively absent"** MUST come from a SUCCESSFUL, code-surfacing per-repo lane
enumeration — a new `worktree-git.ts` helper returning a discriminated
`{ ok: true; branches: Set<string> } | { ok: false }`, bounded by
`GIT_LOCAL_TIMEOUT_MS`. Do NOT use `branchExists` / `listEpicLaneBranches`: both
collapse error→`false`/`[]` and carry no timeout. `absent = enumeration-ok ∧
keeper/epic/A ∉ set`; enumeration-error → defer every dependent in that repo.

**Half-2 is deliberately OMITTED** (no `computeReadiness` change): in worktree mode
`applyPerRootRoundRobinAllocator` early-returns to the LANE-keyed
`applySingleTaskPerRootMutex` (`readiness.ts:1611-1622`), giving every distinct epic
its own cap-1 lane key — so a deferred `[ready]` B claims only its own unique lane
(starves no sibling) and, continue'd above the budget gate, consumes no budget. The
per-root contention the general armed-eligibility gate guards does NOT exist under
per-lane keying. Leave an inline comment so a future reader doesn't re-add it. (The
cosmetic `[ready]`-but-unlaunched board state is accepted; the parked observability
plan owns the durable surface.)

**Optional ephemeral diagnostic:** a single `console.error`/`console.warn` when an
epic is deferred (mirror finalize's `retrySkip` logging) so a stuck-on-orphaned-A B
is diagnosable — ephemeral only, never a durable / sticky row.

### Investigation targets

**Required** (read before coding):
- src/autopilot-worker.ts:1443-1449, 1471-1500 — where `eligible` is computed once/cycle + the `computeReadiness` call; the gate-arm template
- src/autopilot-worker.ts:1540-1700 — the per-row launcher (work rows ~1559, close row ~1620-1685); add the deferred `continue` arms mirroring the armed gate
- src/autopilot-worker.ts:3920-3984 — `loadReconcileSnapshot`'s git pass (`memoizedNullableGitToplevel`, `classifyWorktreeRepos`, `worktreeMode` gating, snapshot return); add `deferredEpicIds`
- src/autopilot-worker.ts:2690-2704 — provision fork-source `gitResolveDefaultBranch` (LOCAL default) — the ancestry ref must match
- src/armed-closure.ts:52-99 — `computeEligibleEpics`: the pure-set template + its null/dangling-edge skips
- src/worktree-git.ts:352-362 (`branchExists`), :477-488 (`isAncestorOf`), :310 (`resolveDefaultBranch`), :692/:716 (`listEpicBaseBranches`/`listEpicLaneBranches`) — reuse; note the boolean/`[]`-collapse + no-timeout gap the new enumeration helper closes
- src/types.ts:817, 828-846 — `resolved_epic_deps` tri-state + `ResolvedEpicDep` shape
- src/readiness.ts:1611-1622 — the worktree per-lane early-return that makes half-2 unnecessary (comment it)

**Optional** (reference as needed):
- src/autopilot-worker.ts:2787-2794, :3393, :3406-3446 — the two teardown delete gates (finalize + recover) the regression test locks
- src/worktree-git.ts:909, src/autopilot-worker.ts:3041-3043 — finalize's `git merge --no-edit` true-merge oracle
- test/autopilot-worker.test.ts:176 (`makeSnapshot`), :3752 (`makeFakeWorktreeDriver`); test/readiness.test.ts:1255/1287; test/helpers/fake-git.ts (`fakeAsyncGit`)

### Risks

- Same-resolved-repo MUST be decided by the upstream's RESOLVED git toplevel, not `dep.cross_project` (two epics can share a repo across project basenames).
- The absent-implies-satisfied arm is sound ONLY for keeper's teardown discipline (branches deleted only when ancestor-of-(origin/)default) AND finalize's non-squash merge; an operator force-deleting an unmerged `keeper/epic/A`, a squash-merge, or an orphan / stuck-non-ff A breaks or parks the gate — document as known stuck-states (the parked observability plan owns the durable surface).
- The probe must NEVER throw out of `loadReconcileSnapshot`; a malformed / null resolved dep folds to "skip this upstream" (not-gating), mirroring `computeEligibleEpics`.
- Walk DIRECT `resolved_epic_deps` only, never the transitive closure (coverage is inductive) — inline-comment it.

### Test notes

All over `fakeAsyncGit` + `makeSnapshot` (no real git — fast tier). Cover:
present∧ancestor→not-deferred; present∧¬ancestor→deferred; absent(enumeration-ok)→not-deferred;
enumeration-error→deferred; ancestry-timeout→deferred; multi-upstream union (one
unmerged defers); cross-repo upstream ignored; B-own-repo-unresolved skipped; the
continue arm suppresses BOTH a work launch AND a close launch for a deferred epic
(assert no `provision` call + no `dispatch_failures` row); empty `deferredEpicIds` is a
byte-identical no-op (OFF / yolo). **Regression test** locking the gate's premise:
assert a `keeper/epic/<id>` base/rib branch is deleted ONLY when an ancestor of
(origin/)default (exercise the finalize + recover delete gates over `fakeAsyncGit`),
and assert finalize merges via `git merge --no-edit` (true merge) so a future switch to
`--squash` fails the test.

## Acceptance

- [ ] In worktree mode, a dependent epic B is not provisioned (no lane cut, no work/close launch) while any same-resolved-repo satisfied upstream A is unmerged into the LOCAL default branch; B provisions the cycle after A's finalize merge lands
- [ ] The defer is no-sticky: NO `dispatch_failures` row minted, no `worktree-recover*` / `worktree-finalize*` key reused; a deferred epic re-evaluates each cycle
- [ ] "Definitively absent" is derived from a successful, timeout-bounded enumeration; a probe error/timeout (enumeration OR ancestry) degrades to DEFER, never to satisfied
- [ ] Same-resolved-repo is decided by the upstream's resolved git toplevel; cross-repo upstreams never gate; multi-upstream uses union (any unmerged defers)
- [ ] Both work-row and close-row launches are suppressed for a deferred epic (no merge-order inversion)
- [ ] `deferredEpicIds` is ephemeral plain data on the snapshot; `reconcile` / `computeReadiness` read git nowhere; empty set is a byte-identical no-op for OFF / yolo; `loadReconcileSnapshot` never throws on a malformed dep
- [ ] A regression test locks: `keeper/epic/<id>` branches are deleted only when ancestor-of-(origin/)default, and finalize uses a true `git merge --no-edit` (not `--squash`)
- [ ] `bun test` green

## Done summary
Added an ephemeral, producer-only cross-epic merge-gate: in worktree mode a dependent epic's lane is deferred (no work/close launch, no sticky row) until every satisfied same-resolved-repo upstream is an ancestor of LOCAL default — probed once per cycle in loadReconcileSnapshot (computeDeferredEpicIds + new enumerateEpicLaneBranches), read as plain deferredEpicIds data by pure reconcile, every inconclusive probe DEFERS.
## Evidence
