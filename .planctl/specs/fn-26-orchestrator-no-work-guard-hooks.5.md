## Description

**Size:** M
**Files:** plugin/hooks/stop-guard.ts, test/stop-guard.test.ts (new), tests/test_stop_guard_hook.py (new)

### Approach

Fill in stop-guard.ts. Hot path first: bypass or no marker for `session_id` → exit 0 immediately (this fires on every stop of every session — no subprocess, no transcript read, before anything else). `stop_hook_active` true → allow.

Work branch (marker kind work): `runPlanctl(["reconcile", task_id])`; done/blocked → allow and clear the marker; tooling_error/typed error/null → allow (fail open); otherwise block once with the checklist reason: "Task <task_id> is not finished (verdict: <verdict>). Before stopping: is the task stamped done? Are the worker's session files committed? Resume the worker (warm SendMessage to the pinned worker_agent_id, or cold `planctl worker resume <task_id>`) — never edit or commit from this context."

Close branch (marker kind close): lenient — the marker only exists if close-finalize never ran (task 1 clears it on every outcome). Allow when `last_assistant_message` carries a typed-stop surface: matches `/^\s*BLOCKED:/m`, contains `QUESTION:`, or quotes a typed error (`error.message` surfacing — match on a `{"success": false` fragment or the skill's verbatim-stop phrasings "Halted \`", "Partial follow-up"). Otherwise block once: "Close of <epic_id> is mid-saga: close-finalize has not run. Either run `planctl close-finalize <epic_id> --project <primary_repo>` (after the agents returned) or surface the typed stop verbatim. Never write or commit from this context."

### Investigation targets

**Required** (read before coding):
- skills/close/SKILL.md — the legitimate non-finalize stop surfaces: QUESTION protocol, transient-failure BLOCKED wording, typed-error surfacing, fatal-halt/partial-followup report formats; derive the allow-list patterns from these exact wordings
- planctl/run_close_finalize.py:68-80 — confirmation that all four outcomes clear the marker (task 1), so a present close marker means finalize never returned success
- template/skills/work.md.tmpl:121-168 — work-branch verdict semantics and resume wording to echo
- plugin/hooks/lib.ts — readMarker / runPlanctl / block emitter

**Optional** (reference as needed):
- https://code.claude.com/docs/en/hooks.md — Stop input fields and 8-block cap

### Risks

- This dispatcher runs on EVERY session stop machine-wide (plugin always loaded) — the no-marker path must stay file-stat cheap; any regression here taxes every Claude session
- Over-eager close blocking would fight the close skill's own legitimate halt states — when a pattern is uncertain, allow; the close branch errs lenient by design
- A work-session human interrupt mid-task will see one checklist block, then pass on the next stop (stop_hook_active) — acceptable, document in the block reason that a deliberate stop may simply stop again

### Test notes

bun units: branch selection by marker kind, work checklist wording, each close allow-pattern, hot-path short-circuit. Pytest slow-bucket subprocess: no-marker fast allow (assert no planctl shim invocation), work block + second-stop allow via stop_hook_active, close block on bare mid-saga stop, close allow on QUESTION:/BLOCKED:/typed-error fixtures, done-verdict allow clears marker.

## Acceptance

- [ ] No-marker stops exit 0 with zero subprocess spawns; bypass honored first
- [ ] Work branch blocks exactly once on non-done/non-blocked verdicts with the resume checklist; done/blocked allow and clear the marker; tooling_error/typed errors allow
- [ ] Close branch blocks only when the close marker exists AND no typed-stop pattern is in the last message; all QUESTION:/BLOCKED:/typed-error/halt-report stops pass
- [ ] stop_hook_active always allows
- [ ] bun test + fast/slow pytest green

## Done summary

## Evidence
