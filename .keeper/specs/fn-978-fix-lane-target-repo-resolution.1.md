## Description

**Size:** M
**Files:** src/git-toplevel.ts, src/autopilot-worker.ts, src/worktree-plan.ts (caller only), src/types.ts, README.md, test/autopilot-worker.test.ts, test/readiness.test.ts, test/git-toplevel.test.ts (new)

### Approach

Resolve every epic's repos to git toplevels ONCE in the producer snapshot-build,
then make the pure lane geometry compare and place by resolved toplevel. Six moves:

1. **`memoizedNullableGitToplevel()` in src/git-toplevel.ts** — mirror
   `memoizedGitToplevel` (:51-60) but cache and return `string | null` with NO
   `?? root` raw fallback, so callers can distinguish "unresolved." Fresh per-cycle
   closure (caches null *within* a build, GC'd at cycle end so a transient failure
   re-resolves next cycle). Short-circuit empty/`""` input to null BEFORE spawning
   (a `git -C "" rev-parse` resolves against the daemon's own cwd). Keep
   `--show-toplevel` (do NOT use `--git-common-dir`).

2. **Classify in `loadReconcileSnapshot`** (mirror the `unseededRoots` build at
   ~2878-2901), gated on `worktreeMode` so OFF-mode adds zero git spawns. Build
   `worktreeRepoByEpicId: Map<epicId, Resolution>` where
   `Resolution = {kind:"ok", repoDir} | {kind:"unresolved", reason} | {kind:"multi-repo", reason}`.
   Per epic: collect each task's raw effective root (`target_repo || project_dir`);
   short-circuit empties; resolve each via the nullable resolver; if ANY required
   root resolves null -> `unresolved`; else if >1 distinct resolved toplevel ->
   `multi-repo`; else `ok{repoDir: the single resolved toplevel}`. Add the field to
   `ReconcileSnapshot` (template at ~485-496) with an empty-map default in
   `makeSnapshot` (test/autopilot-worker.test.ts:167).

3. **Consolidate into one pure `prepareWorktreeGeometry(epics, worktreeRepoByEpicId)`**
   returning `{laneKeyById, byEpicId}`. Delete BOTH local raw `repoDirs` blocks
   (attachWorktreeGeometry :1607-1612, buildLaneKeys :1692-1697). Gate consumes
   `laneKeyById` (into `computeReadiness` at :1284); dispatch consumes `byEpicId`
   (in `attachWorktreeGeometry` at :1537). `deriveWorktreePlan` runs ONCE per epic
   per cycle inside the helper, called with the RESOLVED toplevel as `repoDir`.

4. **Map the three kinds:** `ok` -> derive plan + stamp geometry; `multi-repo` ->
   existing sticky `worktree-multi-repo` `worktreeReject`; `unresolved` -> NEW sticky
   `worktree-repo-unresolved` `worktreeReject` (distinct reason literal, minted via
   the same `emitDispatchFailed`/`failedKeys` path as `cwd-missing`, cleared by
   `retry_dispatch`). PRESERVE the cyclic-DAG asymmetry: the gate skips a
   `WorktreeCycleError`, dispatch re-throws to `driveCycle`'s backstop — do NOT
   swallow it into a gate-style skip (else a cyclic epic launches into its raw cwd).

5. **Sweep sibling raw readers:** `reposForRecovery` (:2496-2543) sources resolved
   toplevels and SKIPS multi-repo/unresolved epics (no lane was provisioned); order
   the `worktreeReject` branch AHEAD of the `dirExists(plan.cwd)` -> `cwd-missing`
   stat (:1926-1965) so an unresolved repo surfaces as `worktree-repo-unresolved`,
   not a generic `cwd-missing`.

6. **Docs + JSDoc:** update the `WorktreeReject` JSDoc (~688-698) and the
   `buildLaneKeys` call-site comment; note `target_repo` pointing INSIDE an existing
   lane worktree is out of scope for v1 (must name a main checkout). Reject reasons
   are free-form `<prefix>: <detail>` literals — no enum/type registration needed.

### Investigation targets

**Required** (read before coding):
- src/git-toplevel.ts:51-60 — `memoizedGitToplevel` (pattern; new one drops the `?? root` fallback)
- src/autopilot-worker.ts:2878-2901 — `unseededRoots` snapshot-build + threading (the producer-resolve pattern to mirror)
- src/autopilot-worker.ts:1559-1622 — `attachWorktreeGeometry` (raw `repoDirs` :1607-1612; `deriveWorktreePlan` :1622; `worktreeReject` mint :1614)
- src/autopilot-worker.ts:1669-1704 — `buildLaneKeys` (raw `repoDirs` :1692-1697; `deriveWorktreePlan` :1703; cycle catch+skip :1704)
- src/autopilot-worker.ts:1284 — `computeReadiness` `laneKeyById` arg; :1537 — `attachWorktreeGeometry` call site
- src/autopilot-worker.ts:1926-1965 — `runReconcileCycle` `cwd-missing` `dirExists` stat (ordering vs `worktreeReject`)
- src/autopilot-worker.ts:2149-2169 — `runWorktreeProducerStep` (consumes `worktreeReject` -> `DispatchFailed`)
- src/autopilot-worker.ts:2496-2543 — `reposForRecovery` (raw `project_dir` -> resolved)
- src/autopilot-worker.ts:646 — `worktree`/`worktreeReject` mutual exclusion; :688-698 — `WorktreeReject` JSDoc; :485-496 — `ReconcileSnapshot.unseededRoots` field template
- src/worktree-plan.ts:145-168 — `deriveWorktreePlan` + `worktreePathFor` (`repoDir` drives the path slug)
- src/gated-roots.ts:132 — `unseededGatedRoots(db, floor, resolver)`: the injectable-resolver precedent

**Optional** (reference as needed):
- test/git-boot-seed.test.ts:470-514 — the injectable synthetic-resolver test seam (fn-921)
- test/readiness.test.ts:2082 / :2125 / :2151 — gate symmetry / multi-repo un-keyed / cyclic-skip tests (must feed the resolved map)
- test/autopilot-worker.test.ts:167 (`makeSnapshot`), :3805-3980 (multi-repo reject + producer-step tests), :3857 (path-pinned slug)

### Risks

- A transient 2s git timeout resolves null -> sticky `worktree-repo-unresolved` darks the epic until `retry_dispatch` (accepted — sticky chosen to match `cwd-missing`; mitigated by the per-cycle memo re-resolving next cycle).
- Passing the resolved toplevel to `deriveWorktreePlan` changes derived worktree-path strings only where a test's `project_dir` wasn't already a toplevel — path-pinned tests must update.
- A previously FALSE `worktree-multi-repo` epic does NOT auto-heal post-land (its sticky `DispatchFailed` persists in `failedKeys`); needs a manual `retry_dispatch` sweep — capture as a deploy note in Done summary (likely zero rows; mode is default-OFF).
- Gate and dispatch MUST consume the identical map (no residual local `repoDirs`) or the bug re-enters.

### Test notes

- All resolution decisions tested via an INJECTED synthetic resolver (no real git), per test/git-boot-seed.test.ts:470. Cases: (a) one task null->`project_dir` + one subdir/symlink/trailing-slash of the same repo, resolver maps both to one toplevel -> NO reject, lane on that toplevel; (b) all tasks target a repo != `project_dir`, one resolved toplevel -> lane + `WorktreeLaunchInfo.repoDir` use the resolved target; (c) two distinct toplevels -> `worktree-multi-repo`; (d) a required root resolves null -> `worktree-repo-unresolved` (distinct from multi-repo); (e) empty root -> unresolved with no spawn; (f) gate<->dispatch symmetry fed the same map; (g) cyclic DAG: gate skips, dispatch re-throws.
- New test/git-toplevel.test.ts: `memoizedNullableGitToplevel` caches null, no double-spawn, null on non-repo. If a real-git assertion is added, allowlist it in scripts/test-real-git-allowlist.txt (`bun run test:hygiene`).
- `bun run test:full` mandatory (daemon/worker/git paths).

## Acceptance

- [ ] A single-repo epic whose tasks' raw `target_repo`/`project_dir` differ but resolve to ONE toplevel (subdir / symlink / trailing-slash) is NO LONGER rejected `worktree-multi-repo` — its lane provisions on the resolved toplevel.
- [ ] An epic whose tasks all share a `target_repo` != `project_dir` (one resolved toplevel) derives its lane base + `WorktreeLaunchInfo.repoDir` from the RESOLVED toplevel, not raw `project_dir`.
- [ ] An epic whose tasks resolve to >1 distinct toplevel is still rejected `worktree-multi-repo`.
- [ ] An unresolvable required root mints a distinct sticky `worktree-repo-unresolved` `DispatchFailed` (not `worktree-multi-repo`, not raw fallback), cleared by `retry_dispatch`.
- [ ] `buildLaneKeys` and `attachWorktreeGeometry` consume one shared `prepareWorktreeGeometry` result off the same `worktreeRepoByEpicId` map; neither re-derives `repoDirs` from raw strings.
- [ ] `reconcile`/worktree-plan stay pure: all git resolution lives in `loadReconcileSnapshot`; worktree mode OFF adds zero git spawns and stays byte-identical.
- [ ] `memoizedNullableGitToplevel` returns null (no raw fallback), caches null per cycle, short-circuits empty input before spawning, mirrors `--show-toplevel`.
- [ ] `reposForRecovery` uses resolved toplevels and skips multi-repo/unresolved epics; `worktreeReject` is evaluated ahead of the `cwd-missing` stat.
- [ ] Cyclic-DAG asymmetry preserved (gate skips, dispatch re-throws to the backstop).
- [ ] Fast tier stays real-git-free (injected resolver); `bun run test:full` passes.
- [ ] README §3196-3198 + §169-171 and the `WorktreeReject` JSDoc updated to describe toplevel normalization + both reject kinds (forward-facing, present tense).

## Done summary
Resolve each epic's target_repo/project_dir to one git toplevel in the producer snapshot-build (classifyWorktreeRepos + nullable per-cycle memo), then place worktree lanes by resolved toplevel via one shared prepareWorktreeGeometry (gate + dispatch). Adds the distinct worktree-repo-unresolved reject. Source landed on the epic branch (commit 397f5708). Deploy note: a previously-FALSE worktree-multi-repo epic keeps its sticky DispatchFailed until a manual retry_dispatch sweep (likely zero rows; worktree mode default-OFF).
## Evidence
