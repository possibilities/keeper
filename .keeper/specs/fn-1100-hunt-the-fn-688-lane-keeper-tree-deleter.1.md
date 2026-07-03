## Description

**Size:** M
**Files:** (investigation-led; likely src/autopilot-worker.ts or an external session's ops — evidence decides)

### Approach

Debug-shaped: witness before theorizing. (1) Instrument/observe the lane: capture its
current state, restore it clean (git checkout -- . — deletions only, HEAD holds
everything), then watch for the re-dirty (fs event log, lsof sampling, or keeper's own
event log: keeper find-file-history / show-session-events for sessions whose cwd or file
ops touch that path). Candidate suspects to rule in/out: keeper daemon sweeps shelling git
with wrong cwd; a stale Claude session/worker still parked in that lane running plan or
cleanup verbs; the docs sidecar/push machinery; an external tool walking worktrees. (2)
When identified, fix at the source (never just re-restore). (3) Tear down: with the lane
clean, let the recover sweep delete it (true merge-ancestor teardown) or remove it
manually per the worktree teardown contract; delete the lane branch; verify the fn-688
recover row auto-clears (worktree-recover* is level-cleared) and drop the fn-688 finalize
row + fn-884 provision row via retry_dispatch. (4) fn-884: explain why a closed epic's
close re-dispatched at all (its lane dir docs-1665k3p also lingers in ~/worktrees) and
whether its provision-failure re-mints; if its base state is inconsistent, surface rather
than force.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- keeper find-file-history / keeper search-history / keeper show-session-events — the forensics recipes for who touched the lane
- src/autopilot-worker.ts — worktree recover/teardown pass (grep -a; the sweep that keeps hitting the dirty lane)

**Optional** (reference as needed):
- ~/worktrees listing — sibling stale lanes (docs-1665k3p--keeper-epic-fn-884-…) that may share the cause

### Risks

- Do NOT force-delete while the deleter is unidentified — the dirt is the tripwire that
  keeps the mystery visible; teardown only after the source is stopped.

## Acceptance

- [ ] Evidence names the process/mechanism that deleted the lane's .keeper tree
- [ ] The lane and branch are gone, the deleter can no longer recreate the state, and all three sticky rows are cleared with no re-mint over a soak window
- [ ] The fn-884 re-dispatch cause is explained (fixed or explicitly filed)

## Done summary

## Evidence
