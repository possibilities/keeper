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

## Evidence
