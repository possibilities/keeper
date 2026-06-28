## Description

**Size:** M
**Files:** plugins/plan/src/project.ts (new resolver), plugins/plan/src/verbs/{block,unblock,task_reset,close_finalize}.ts, plugins/plan/src/cli.ts (--project for block/unblock/task-reset), plugins/plan/test/* (resolver unit + source guard)

### Approach

1. **Add `resolvePlanStateContext(id, project, format): ProjectContext`** in
project.ts beside `resolveOwningProjectForId` (project.ts:174). Three phases:
(Phase 1) LOCATE the owning def via `resolveOwningProjectForId(id, project, format)`
(cwd-then-global; `--project` bypass) — and if `project !== null` return that locate
ctx outright (operator intent wins). (Phase 2) `epicId = isTaskId(id) ? epicIdFromTask(id) : id`;
read `epicDef.primary_repo` from `join(locate.dataDir,"epics",epicId+".json")` (loadJsonSafe);
`stateRoot = epicDef.primary_repo || locate.projectPath`; return
`contextForRoot(realpathOr(stateRoot))`. (Phase 3) FAIL LOUD via `emitError` when the
primary lacks a data dir (`hasDataDir`) or the id's def (`idExistsInProject`,
project.ts:207) — never a silent lane-adjacent write. Reuse contextForRoot
(project.ts:62), isTaskId, epicIdFromTask, loadJsonSafe, realpathOr. Return a THIN
ProjectContext (near drop-in for the `ctx` verbs already hold) — do NOT invent a rich
`{stateCtx,defCtx,…}` shape (it re-introduces wrong-field risk; code/def-from-lane is
already served by `resolveWorkerRepos().targetRepo` + `process.cwd()`).

2. **Migrate the three pure-overlay-writer holes** — block (block.ts:36,76), unblock
(unblock.ts:32,65), task reset (task_reset.ts:36,52). Replace `resolveProject(format)`
with `resolvePlanStateContext(taskId, project, format)`; route `saveRuntime` through
the returned ctx.stateDir. ADD a `--project` flag at the CLI for all three (cli.ts —
they have none today). These are pure RT-W with no code-cwd concern → simplest +
highest value (a lane-written `block` never reaches the daemon's escalation).

3. **close-finalize 2-line tally fix** — `close_finalize.ts:428-429` ALREADY computes
`const primaryRepo = realpath(epicDef.primary_repo || ctx.projectPath)` (used only for
the followup READ at :542). Build `const stateCtx = contextForRoot(primaryRepo)` and
pass `stateCtx` (not the cwd `ctx`) to `closeEpic` (:554/:515/:526) and
`scaffoldFollowup` (:553), so the irreversible epic-close tally + the follow-up mint
land in PRIMARY even when run from a lane without `--project`. No new resolution; the
value is in scope. (This removes the --project discipline-dependency AND the
orphaned-follow-up-into-lane bug.)

4. **Default-deny SOURCE guard** — a source-inspection test (model on the existing
consistency-*/src-* tests) scanning `src/verbs/*.ts`: any verb that constructs
`new LocalFileStateStore(...)`, writes an audit artifact, or uses `ctx.stateDir` for
RT/AUD work must import `resolvePlanStateContext` OR be on an explicit display/DEF
allowlist (cat/show/list/status/ready/epics/refine-context/find-task-commit/scaffold/
refine-apply/mv-repo/task-set-target-repo/detect/validate). Because slices 2-4 haven't
migrated their verbs yet, seed a SHRINKING temporary exempt-list of the not-yet-migrated
stateful verbs (done/claim/reconcile/resolve-task/worker-resume/epic-close/epic-rm/
submits) — each later slice removes its verbs from that exempt-list as it migrates them.
Default-deny (not a registry) is what catches a FUTURE forgotten verb.

### Investigation targets

**Required** (read before coding):
- plugins/plan/src/project.ts:62 (contextForRoot), :174-207 (resolveOwningProjectForId + idExistsInProject), and the helpers loadJsonSafe/isTaskId/epicIdFromTask/realpathOr/hasDataDir
- plugins/plan/src/verbs/close_preflight.ts:124-136 (the precedent to lift verbatim)
- plugins/plan/src/verbs/{block,unblock,task_reset}.ts (the cwd-first writers) + cli.ts dispatch for them (no --project today)
- plugins/plan/src/verbs/close_finalize.ts:428-429 (primaryRepo already computed), :515,:526,:553,:554 (the cwd-ctx call sites to re-point), epic_close.ts:39,75,85 (force:false refusal)
- the existing source-inspection tests (consistency-*/src-*) as the guard model; plugins/plan/test/worktree-{done,close}-state.test.ts for the lane-simulation harness + KEEPER_PLAN_WORKTREE lever (runtime_status.ts)

### Risks

- `--project` stays authoritative for LOCATING (operator intent), but a non-null primary_repo owns PHYSICAL state — keep that split exact.
- Thin-ctx must be a true drop-in: verbs route state through ctx.stateDir; do not also read code from the primary ctx (code stays cwd / targetRepo).
- The default-deny guard must accommodate the staged migration (shrinking exempt-list), else slice-1 turns the gate red for not-yet-migrated verbs.
- close-finalize: keep `force:false` semantics; only re-root the ctx, do not change the refusal behavior.
- Preserve the CLAUDE.md STATE-vs-PATH invariant (KEEPER_PLAN_WORKTREE never leaks into the state path).

### Test notes

Resolver unit (pure): from a lane cwd with epic.primary_repo=primary → ctx.projectPath===primary (task-id AND epic-id); from primary cwd → no-op; `--project X` → X; **primary-outside-roots** (setRoots to an unrelated dir; primary NOT a root child) → still resolves to primary (the Q7 gap, currently untested anywhere); primary missing data dir/def → emitError (fail loud); KEEPER_PLAN_WORKTREE set → resolver unchanged, only targetRepo moves. Verb tests: block/unblock/task-reset from a lane (no --project) flip the overlay in PRIMARY, not the lane. close-finalize from a lane without --project tallies primary's overlay + mints the follow-up into primary. Source guard: a synthetic verb touching ctx.stateDir without the resolver fails the scan.

## Acceptance

- [ ] resolvePlanStateContext added (thin primary-rooted ctx; --project-locate; def.primary_repo key; fail-loud on missing primary def)
- [ ] block/unblock/task-reset route state to primary + accept --project; a lane-run flips primary's overlay
- [ ] close-finalize threads contextForRoot(primaryRepo) into closeEpic + scaffoldFollowup (no orphaned-follow-up, no --project dependency for the tally)
- [ ] default-deny source guard lands (shrinking exempt-list for not-yet-migrated verbs)
- [ ] resolver unit tests incl. primary-outside-roots + fail-loud; pure tier green

## Done summary

## Evidence
