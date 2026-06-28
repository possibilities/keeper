## Description

**Size:** S
**Files:** plugins/plan/src/verbs/done.ts, plugins/plan/agents/worker-*.md, plugins/plan/test/* (new + updated)

### Approach

The worker `done` flip is the sibling seam the .1/.2 workers hit (they had to run
`done` from primary to mark a task done). `runDone` (done.ts:49) resolves the owning
project via `resolveOwningProjectForId` (done.ts:65) -> `resolveEpicGlobally`, which
has a cwd short-circuit (discovery.ts:235-252): the lane's COMMITTED
`.keeper/epics/<id>.json` makes the lane win, so done reads/writes the runtime overlay
in the LANE (absent -> "task not in_progress") instead of primary.

THE FIX — resolve done's owning project LANE-BLIND, like claim/resolve-task. claim
uses `findProjectsWithTask` (discovery.ts:81-96), which scans IMMEDIATE children of the
configured roots only (lanes under `~/worktrees/` are never discovered) -> always lands
on primary. Switch `runDone`'s resolution to that lane-blind path (resolve the task's
owning project via `findProjectsWithTask(taskId)` and root the state store there), so
the runtime overlay is written to primary regardless of cwd. Do NOT change the shared
`resolveOwningProjectForId` itself — it is also used by cat/show/refine-context, whose
cwd-first semantics must stay; make the change done-LOCAL. Keep done's `--project`
override authoritative when passed (done.ts:65 + cli.ts:867). Mirror claim.ts:117-161
exactly for the resolution shape.

Reconcile the now-accurate worker-prompt guidance: worker-*.md:69 says "State writes
(`keeper plan done`, etc.) auto-route to PRIMARY_REPO … you do not need to chdir" —
currently FALSE in worktree mode, TRUE after this fix. Confirm the wording is accurate
across the worker tiers (forward-facing, no provenance, rule #0).

### Investigation targets

**Required** (read before coding):
- plugins/plan/src/verbs/done.ts:49-70, :189 (resolveOwningProjectForId at :65, saveRuntime at :189)
- plugins/plan/src/discovery.ts:36-96 (findProjectsWithTask — lane-blind), :215-252 (resolveEpicGlobally + the cwd short-circuit :235-252 = the leak)
- plugins/plan/src/verbs/claim.ts:117-161 (the proven lane-blind resolution to mirror)
- plugins/plan/agents/worker-high.md:69 (+ the other worker-*.md tiers — the auto-route claim to reconcile)
- plugins/plan/src/cli.ts:860-869 (done CLI wiring + its `--project`)

### Risks

- Do NOT modify the shared `resolveOwningProjectForId` (used by cat/show/refine-context) — make the resolution change done-LOCAL.
- A task not found under any configured root (a detached / throwaway project) must still resolve — keep a sane fallback (the existing resolver or `--project`) so single-project non-worktree use is unaffected.
- Keep done's `--project` override authoritative when passed.
- State stays on primary; never write the overlay to the lane.

### Test notes

Pure tier (no real git): a "primary" tmp project with the task in_progress (runtime
overlay in primary's `state/`) + a "lane" dir holding ONLY committed defs (no `state/`).
Run `done` from the lane (cwd=lane) -> assert the runtime overlay flips to done in
PRIMARY (not the lane), and `done` reports success (not "not in_progress"). Mirror
saga-claim.test.ts's lane-blind setup + the `KEEPER_PLAN_WORKTREE` lever. Add a guard
that done's `--project` override still wins.

## Acceptance

- [ ] the worker `done` flip resolves the task's state file to epic.primary_repo when cwd is a lane (lane-blind, like claim) -> flips done in primary, not the lane
- [ ] the shared resolveOwningProjectForId is unchanged (cat/show/refine-context cwd-first semantics preserved)
- [ ] done's `--project` override stays authoritative; single-project non-worktree use unaffected
- [ ] worker-*.md:69's "auto-route to PRIMARY_REPO" guidance is accurate after the fix
- [ ] pure test: done-from-lane flips primary's runtime overlay (not the lane's)

## Done summary
runDone resolves its owning project lane-blind (findProjectsWithTask, like claim), so a done run from a worktree lane flips the runtime overlay on the epic's primary repo, never the lane. --project stays authoritative; projects outside any root fall back to cwd-then-global. The shared resolveOwningProjectForId is untouched.
## Evidence
