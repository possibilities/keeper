## Overview

Two root-caused harness-drop classes survived the fn-37 audit unaddressed. The shipped fn-37 hardening prose routes file content to Write/Edit, but task .2 proved that ~24% of worker spawns get Edit/Write in neither the direct tool set nor the deferred registry, so those spawns cannot follow the rule and silently fall back to the exact giant-heredoc drop mode the epic targeted. Separately, task .3's silent-death census found that the dominant recoverable class (SILENT_STREAM_CUT) and the costliest terminal class (PARENT_SESSION_TEARDOWN) have no detector or guard today. This follow-up closes both gaps: it hardens the worker against tool-omission spawns and adds drop detection/teardown protection on the orchestration side.

## Acceptance

- [ ] A worker that spawns with neither Edit nor Write available fails loud (BLOCKED: TOOLING_FAILURE) instead of silently degrading to heredocs.
- [ ] The deferred-tool-registry omission is filed upstream with the task .2 evidence.
- [ ] The dominant silent-death class (SILENT_STREAM_CUT) is detected as a synthetic drop signal that drives auto-resume.
- [ ] In-flight workers are drained or checkpointed before a parent session_end so PARENT_SESSION_TEARDOWN stops causing terminal work-loss.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | worker.md.tmpl:93 prose presupposes Write/Edit are available, but task .2's 24% neither-class spawns cannot use them; no Phase-1 tooling self-check and no frontmatter allowedTools exist today. |
| F2 | kept | .1 | task .2 transcript proof (empty ToolSearch(select:Edit), 25 heredoc writes, no deferred-tools reminder) plus 135/565 neither-class partition substantiate an upstream harness defect worth a filed report. |
| F3 | merged-into-F1 | .1 | F3 (Phase-1 worker self-check BLOCKing TOOLING_FAILURE when neither tool is present) is the concrete fix completing F1's incomplete prose mitigation; same root cause and same worker.md.tmpl surface, so F3 folds into F1's task. |
| F4 | kept | .2 | task .3: SILENT_STREAM_CUT is 50/82 deaths with 0/50 api_error correlation, the dominant actionable recovery lever via a keeper-side synthetic-drop detector. |
| F5 | kept | .2 | task .3: PARENT_SESSION_TEARDOWN is 7/82 deaths, all terminal work-loss with parent session_end within 0-3s, recoverable by a parent-side drain/checkpoint guard. |
| F6 | culled | — | CLAUDE_RESTART is n=1 auto-update collateral and task .3 itself recommends deferring; below the recurring-impact bar. |

## Out of scope

- CLAUDE_RESTART auto-update collateral (F6) — n=1, deferred to a later cycle.
- The precise harness mechanism that decides deferred-registry membership per spawn — task .2 flagged it as not introspectable from transcripts/db; this epic mitigates the symptom and files the report rather than reverse-engineering the harness internals.
