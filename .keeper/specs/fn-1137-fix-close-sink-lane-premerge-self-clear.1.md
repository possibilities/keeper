## Description

Fixes F1 (evidence: src/autopilot-worker.ts:3006 vs the level-clear at
src/autopilot-worker.ts:566). The non-primary close-sink provision-failure
arm emits its `worktree-lane-premerge` DispatchFailed with
`dir: sink.repoDir` (the repo toplevel). `loadReconcileSnapshot` collects
`verb === "close"` premerge rows into `laneFailures`
(src/autopilot-worker.ts:5129-5139), and `laneFailuresToClear`
(src/autopilot-worker.ts:558-571) clears a row ONLY when its normalized
`dir` is in the resolved lane-PATH set — a repo toplevel is never a lane
path, so the close-sink row can never self-clear and lingers until a manual
`retry_dispatch`. The work-cell twin is already correct: it emits
`dir: wt.dir` (= `provisioned.dir ?? launchCwd`,
src/autopilot-worker.ts:2834 / 3115). Fix the close-sink emit to
`dir: provisioned.dir ?? sink.repoDir`, mirroring the work path. The
`provisioned` result already carries `dir?: string` (WorktreeDriver.provision
contract), so the value is available.

Also folds in F2: the sole fn-1123 sink test drives `{ ok:false, retry:true }`,
a shape the driver's premerge arm no longer produces, so no test guards the
close-sink self-clear. Add a test exercising a real close-sink
(`worktreeSinkProvision`) premerge failure that asserts the minted
`close::<epic>` row's `dir` equals the sink lane path AND that it self-clears
once the lane resolves (probeLaneBaseReadiness reports resolved).

Files: src/autopilot-worker.ts (the close-sink emit), test/autopilot-worker.test.ts (the regression test).

## Acceptance

- [ ] The close-sink premerge arm emits `dir: provisioned.dir ?? sink.repoDir`; a non-primary sink premerge row keys on the lane worktree path.
- [ ] A new test drives a real close-sink premerge failure, asserts the emitted dir is the sink lane path, and asserts the row self-clears once the lane resolves.
- [ ] Fast suite green.

## Done summary
Keyed the non-primary close-sink fan-in pre-merge DispatchFailed on the sink LANE worktree path (provisioned.dir ?? sink.repoDir) so it self-clears like the work-cell twin instead of lingering until a manual retry_dispatch, and added a regression test driving a real close-sink premerge failure that asserts both the emitted lane-path dir and the reason-scoped self-clear.
## Evidence
