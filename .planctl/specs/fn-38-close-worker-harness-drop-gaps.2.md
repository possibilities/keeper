## Description

Closes F4 and F5, both from task .3's silent-death census (82 deaths across 1648 invocations). Two distinct mechanisms on the orchestration/keeper drop-recovery surface share the theme "stop silent harness drops from losing work" and land as one task. F4: SILENT_STREAM_CUT is the dominant actionable class (50/82, 0/50 correlating with any api_error within +/-90s) and emits no error event, so add a keeper-side synthetic-drop detector that flags "subagent_stop with prior assistant stop_reason=tool_use/null and no terminal text" as a synthetic drop signal to drive faster auto-resume — analogous to the existing exit-watcher synthetic Killed events. F5: PARENT_SESSION_TEARDOWN (7/82, all terminal work-loss, parent session_end within 0-3s of death) needs a parent-side guard that drains or checkpoints in-flight workers before session_end so these stop being unrecoverable. Sample evidence sids: F4 — 492f5307 (subagent_stop@+3s then resume@+21s), cfcbc8ec, ea343ed2; F5 — 9687dcdd (session_end@+3s), c81bf8fe (session_end@+1s).

## Acceptance

- [ ] A keeper-side detector mints a synthetic drop signal for the SILENT_STREAM_CUT signature (subagent_stop after stop_reason=tool_use/null with no terminal text and no api_error) and drives auto-resume.
- [ ] A parent-side guard drains or checkpoints in-flight workers before session_end so PARENT_SESSION_TEARDOWN no longer causes terminal work-loss.
- [ ] Both paths are exercised against the task .3 evidence signatures (or representative fixtures) without false-positiving on normal end_turn yields.

## Done summary

## Evidence
