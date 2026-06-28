## Description

**Size:** M
**Files:** plugins/plan/src/verbs/{worker_resume,epic_close,epic_rm}.ts, plugins/plan/src/cli.ts, plugins/plan/test/*

### Approach

- **worker-resume CLEAN SPLIT** (the two halves resolve from different roots):
  STATE → primary: `const stateCtx = resolvePlanStateContext(taskId, null, format)`; read
  status via `new LocalFileStateStore(stateCtx.stateDir).loadRuntime` (replaces the lane
  read at worker_resume.ts:78); write the regenerated brief under `stateCtx.stateDir/briefs`
  (replaces :117) — the brief is gitignored state, read by the respawned worker via
  absolute BRIEF_REF, so a primary-rooted brief is readable from the lane. CODE → cwd/lane:
  `readGitState()` (worker_resume.ts:33) + `findSourceCommitSha()` (:41) keep probing
  `process.cwd()` (the worker's uncommitted code); `target_repo` stays
  `resolveWorkerRepos().targetRepo`.
- **epic close standalone** (epic_close.ts:39,75): replace `resolveProject` with the
  resolver; add `--project`. (It's reached via close-finalize's re-rooted ctx after slice 1,
  but harden the standalone path too.)
- **epic rm** (epic_rm.ts:276,201,302): route the unlink set + state deletion through the
  resolver so a lane-run deletes PRIMARY's artifacts (not the lane's empty state, orphaning
  primary). Keep `--project`. SAFER alternative if cleaner: refuse `epic rm` in a linked
  worktree without `--project` (fail loud) rather than auto-route a destructive op.
- Remove these verbs from the source-guard exempt-list.

### Investigation targets

**Required** (read before coding):
- plugins/plan/src/verbs/worker_resume.ts:33,41,55,78,98,103,117 (the status read + brief write to split from the git/code probes)
- plugins/plan/src/verbs/epic_close.ts:39,75,85; epic_rm.ts:201,276,283,302
- plugins/plan/test/saga-worker-resume.test.ts (add a lane-vs-primary overlay/brief assertion — currently none)

### Risks

- worker-resume runs IN the lane by design — only STATE moves to primary; the git/brief-code probes MUST stay cwd-local. Do not move the code probes.
- epic rm is destructive — auto-routing to primary from a lane must delete the RIGHT (primary) artifacts; if any doubt, prefer the fail-loud-without-`--project`-in-a-lane stance.
- epic-close keep force:false refusal semantics.

### Test notes

worker-resume from a lane: status read + brief write land in primary; git/source-commit probes still read cwd. epic-close standalone from a lane (no --project) → tallies primary (or fails loud). epic-rm from a lane → deletes primary's artifacts (or refuses). Pure tier + saga-worker-resume extension.

## Acceptance

- [ ] worker-resume STATE (status read + brief write) → primary; CODE (git/source probes, target_repo) → cwd/lane
- [ ] epic-close standalone routes via the resolver + accepts --project; force:false refusal intact
- [ ] epic-rm routes destructive ops to primary (or refuses in a lane without --project) — never orphans primary state
- [ ] these verbs removed from the source-guard exempt-list; pure tier green

## Done summary

## Evidence
