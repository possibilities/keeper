## Description

**Size:** M
**Files:** none (read-only investigation; findings land in this task's Done summary / Evidence)

Attribute what tears down autopilot tmux windows while a worker subagent is
still mid-turn, producing the PARENT_SESSION_TEARDOWN drop class. Read-only:
keeper db forensics + keeper source reading. No fix is applied — the
deliverable is attribution and a recommendation (guard vs. tracing).

### Approach

1. Reproduce + extend the census. From the silent-death recipe, isolate
   deaths where a worker subagent was actively mid-tool-call (last record a
   work:worker/plan:worker tool_result or PreToolUse) immediately before the
   parent `SessionEnd reason=other`. Record each: ts, session_id, plan_verb,
   plan_ref, backend_exec_type, and whether another session died within +/-5s
   (multi-session-teardown signature).
2. Split by era at 2026-06-11 (the fn-802 reaper's creation). For any
   post-2026-06-11 case, correlate the death ts against the reaper's stderr
   audit line ("one stderr audit line per attempt", reaper-worker.ts:34) in
   the keeperd launchd logs — a match implicates the reaper; check whether the
   reaped job's perTask verdict could have read `{tag:"completed"}` while its
   worker subagent still had an open turn (the job `state` reflects the
   orchestrator's main-loop Stop, which fires when it delegates to the Task
   subagent — establish whether a `work` row can read stopped+completed with a
   live subagent inside it).
3. For pre-2026-06-11 cases, enumerate every teardown surface that existed
   then and could kill a window: the prior ~60-80s reap mechanism (commit
   80e3dbb7 context), the autopilot completion-reap, setup-tmux / dash
   rebuilds, the since-removed zellij exec backend, exit-watcher actions, and
   non-keeper causes (machine sleep via `pmset -g log | grep -E "Sleep|Wake"`,
   Claude Code auto-update restarts via the transcript `version` field).
   Correlate each sampled death against these and attribute or eliminate.
4. Conclude: name the mechanism(s) responsible, or declare the class
   unattributable from existing data and state exactly what evidence is
   missing.

### Investigation targets

**Required** (read before coding):
- src/reaper-worker.ts (selectReapCandidates :143-197; kill path + cooldown :240-304; audit line) — the new reaper's exact gate and what it logs
- src/exec-backend.ts:337-620 (buildTmuxKillWindowArgs, killWindow) — the actual tmux kill
- src/readiness.ts (computeReadiness; perTask verdict construction) — whether a live-subagent `work` row can read `{tag:"completed"}`
- src/reducer.ts (job state machine: when a `work` job becomes `stopped`; the SessionEnd / Stop / SubagentStop arms ~:3751-4001) — the crux of whether stopped+completed can coexist with a live worker subagent
- keeper db: events (SessionEnd reason, SubagentStart/Stop, BackendExecSnapshot) via COALESCE(e.data, b.data) LEFT JOIN event_blobs

**Optional** (reference as needed):
- keeperd launchd stdout/stderr log path (the reaper audit lines) — find via the LaunchAgent plist
- git log for the prior teardown mechanism (commit 80e3dbb7) and the zellij-backend removal (fn-799)

### Risks

- Attribution may be impossible for older/external causes (pmset log rotation, no durable reap trace pre-fn-802). That is an acceptable outcome — it converts the deliverable into a tracing recommendation rather than a cause.

### Test notes

No tests — read-only forensics. Evidence is the attribution table (per case: ts, mechanism, supporting signal) plus the reaper cleared/implicated verdict, in the Evidence section.

## Acceptance

- [ ] Mid-worker teardown cases enumerated with the active-worker-before-SessionEnd signature and the multi-session-teardown check; split by the 2026-06-11 reaper era.
- [ ] The fn-802 reaper is explicitly cleared or implicated, with the stopped+`{tag:"completed"}`-vs-live-subagent question resolved from the reducer/readiness code.
- [ ] Each sampled death is attributed to a named mechanism with evidence, or the class is declared unattributable with the exact missing evidence stated.
- [ ] A recommendation is recorded in the Done summary: a targeted guard (keeper-owned preventable cause) or the minimal durable tracing (unattributable). Zero code changes in this task.

## Done summary
ATTRIBUTION (read-only, zero code changes). Census: 13 true mid-worker open-turn teardowns (last *:worker PreToolUse/PostToolUse with NO intervening SubagentStop before SessionEnd reason=other) — 11 pre-2026-06-11, 2 post. Discriminator was SubagentStop-presence between last worker tool event and SessionEnd; substop_after=0 isolates the genuine open-turn class from end-of-session lag. Both sampled deaths confirm the signature: 9687dcdd (2026-06-08, work:worker Bash 3s before SessionEnd), c81bf8fe (2026-05-29, work:worker Read 14s before). Multi-session signature confirmed: 9687dcdd and 4f59f656 share the exact Killed-mint second (06:31:31) and TranscriptTitle second — one exit-watcher reprobe swept both.

REAPER CLEARED (code + data). Code: the reaper gates on state='stopped' AND a {tag:'completed'} verdict; 'completed' requires worker_phase='done' (planctl worker_done_at, set only by the worker calling planctl done), and reducer.ts Stop arm's subagent-guard (MAX_STOP_YIELD_GAP_SEC=120) swallows the state-flip to 'stopped' while any subagent_invocations row is running and younger than 120s — so a work row cannot read stopped+completed while its worker subagent has an open turn. Data: NONE of the 13 open-turn deaths appear in the reaper kill log; zero recheck-miss aborts. All 12 post-reaper reaper kills on 2026-06-12/13 are substop_after=1 (worker finished cleanly first) — correct behavior. The 2 post-reaper open-turn deaths (eee05990, 30eca23f) were /plan planning sessions (not autopilot work/close MANAGED_EXEC_SESSION rows) the reaper never targets.

EXTERNAL CAUSE for the open-turn class. Machine sleep RULED OUT: no pmset Sleep/Wake transition near 9687dcdd (05:16), eee05990, or 30eca23f. Exit-watcher RULED OUT as cause — it is a detector only (reprobeLoop mints synthetic Killed for an already-dead pid, age-gated 5min; explains 9687dcdd's 75-min-late Killed). Reaper landed 2026-06-11 23:12 / tightened 2026-06-12 10:19, AFTER both sampled deaths. Remaining cause is the reason=other external process termination (window/pane kill, SIGHUP/SIGTERM) racing a live worker — UNATTRIBUTABLE to a specific keeper mechanism from existing data.

MISSING EVIDENCE: (1) pmset log rotates at 2026-06-07 18:38, so the 2026-05-29 death predates all sleep evidence; (2) no Claude Code 'version' field is captured in keeper events, so auto-update-restart teardown is untestable.

RECOMMENDATION (tracing, not a guard — no keeper-owned preventable cause found): the reaper is the only keeper teardown surface and is provably cleared, so a guard has nothing to guard. Add the minimal durable tracing to make future mid-worker teardowns attributable: (a) on SessionEnd reason=other, fold a queryable flag when an open worker turn exists (last *:worker tool event with no SubagentStop) so the open-turn class is a first-class signal instead of a forensic reconstruction; (b) capture the transcript 'version' field on SessionStart/SessionEnd to make the auto-update-restart hypothesis testable. Reaper kills are already a queryable signal candidate via the existing stderr audit line — promoting that to a synthetic event would make any FUTURE post-reaper case self-attributing.
## Evidence
