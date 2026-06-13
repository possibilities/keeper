## Overview

Two root-caused harness-drop classes survived the fn-37 audit unaddressed.
The shipped fn-37 hardening prose routes file content to Write/Edit, but task
.2 proved that ~24% of worker spawns get Edit/Write in neither the direct tool
set nor the deferred registry, so those spawns cannot follow the rule and
silently fall back to the exact giant-heredoc drop mode the epic targeted.
Separately, task .3's silent-death census found that the dominant recoverable
class (SILENT_STREAM_CUT) and the costliest terminal class
(PARENT_SESSION_TEARDOWN) have no detector or guard today.

This follow-up closes both gaps. Task .1 (done, planctl) hardened the worker
template against tool-omission spawns and filed the upstream report. Tasks .2
and .3 are keeper-side drop-recovery work and **target `/Users/mike/code/keeper`**
— the detectors and the resume path live in keeper's exit-watcher / reducer /
autopilot surface, not in planctl. They are split because they touch distinct
keeper subsystems and land as separate commits under keeper's single-surface
discipline.

## Acceptance

- [ ] A worker that spawns with neither Edit nor Write available fails loud (BLOCKED: TOOLING_FAILURE) instead of silently degrading to heredocs. (.1, done)
- [ ] The deferred-tool-registry omission is filed upstream with the task .2 evidence. (.1, done)
- [ ] The dominant silent-death class (SILENT_STREAM_CUT) is detected as a synthetic drop signal that drives auto-resume. (.2, keeper)
- [ ] PARENT_SESSION_TEARDOWN orphans are recovered (detected and re-dispatched, or drained before teardown) so they stop causing terminal work-loss. (.3, keeper)

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | worker.md.tmpl:93 prose presupposes Write/Edit are available, but task .2's 24% neither-class spawns cannot use them; no Phase-1 tooling self-check existed. |
| F2 | kept | .1 | task .2 transcript proof + 135/565 neither-class partition substantiate an upstream harness defect worth a filed report. |
| F3 | merged-into-F1 | .1 | F3 (Phase-1 worker self-check) completes F1's prose mitigation on the same worker.md.tmpl surface. |
| F4 | kept | .2 | task .3: SILENT_STREAM_CUT is 50/82 deaths with 0/50 api_error correlation, the dominant recovery lever via a keeper-side synthetic-drop detector. Targets keeper. |
| F5 | kept | .3 | task .3: PARENT_SESSION_TEARDOWN is 7/82 deaths, all terminal work-loss; both sampled cases were autopilot-dispatched, so keeper's autopilot is the natural resumer. Split from F4 (distinct keeper surface). Targets keeper. |
| F6 | culled | — | CLAUDE_RESTART is n=1 auto-update collateral; below the recurring-impact bar. |

## Out of scope

- CLAUDE_RESTART auto-update collateral (F6) — n=1, deferred to a later cycle.
- The precise harness mechanism that decides deferred-registry membership per spawn — task .2 flagged it as not introspectable; this epic mitigates the symptom rather than reverse-engineering harness internals.
