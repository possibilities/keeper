## Overview
The tmux window-reaper (src/reaper-worker.ts) kills jobs by `backend_exec_pane_id`, but ended/killed jobs retain their stale pane id forever (113 terminal jobs hold pane ids spanning %0-%519) and tmux recycles `%N`. So a freshly-created window gets a pane id a long-dead job still claims, and the reaper collateral-kills the live window. The pre-kill TOCTOU recheck only re-confirms the JOB still qualifies, never that the pane still BELONGS to it. Guard the reaper against recycled panes AND stop dead jobs from holding live-recyclable pane ids.
## Quick commands
- bun run test:full   # touches reaper / worker / db / fold paths
## Acceptance
- [ ] reaper never kills a pane whose live tmux generation != the job's recorded `backend_exec_generation_id`
- [ ] terminal (ended/killed) jobs carry NULL `backend_exec_pane_id` after the fold
- [ ] forward-only migration clears `backend_exec_pane_id` on existing terminal jobs; SCHEMA_VERSION bumped + whitelisted
## Early proof point
Task that proves the approach: `.1` (reaper generation-guard). If it fails: fall back to a recency bound on reap candidates (only reap jobs updated within a short window).
## References
- fn-976-rescue-worktree-mode-lane-isolation (landed concurrently; disjoint files: peer owns autopilot-worker.ts + exec-backend.ts, this epic owns reaper-worker.ts + the backend_exec fold + backend_exec_generation_id)
