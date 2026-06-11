## Description

**Size:** S
**Files:** plugin/hooks/subagent-stop-guard.ts, test/subagent-stop-guard.test.ts (new), tests/test_subagent_stop_guard_hook.py (new)

### Approach

Fill in subagent-stop-guard.ts as the FIRST-CHANCE resume engine (epic spec precedence rule). Ladder: bypass → allow; `stop_hook_active` true → allow (block-once policy); `last_assistant_message` matches `/^\s*BLOCKED:/m` → allow (typed escalation outranks reconcile, which cannot distinguish escalation from a drop); resolve task id from the session marker (kind work), falling back to a `TASK_ID: <id>` line parsed from the spawn prompt in `agent_transcript_path`'s first user message; no task id → allow. Then `runPlanctl(["reconcile", task_id])` and map: done/blocked → allow (clear marker on done); tooling_error, typed error, null → allow (fail open). Otherwise emit top-level `{"decision":"block","reason":<verdict nudge>}` with the Phase 2b nudges: in_progress_committed → "Source commit landed — run planctl done <task_id> --summary now"; in_progress_uncommitted → "Finish implementation, run tests within budget, keeper commit-work, planctl done"; state_uncommitted → "Re-run planctl done <task_id> --summary to land the state commit"; not_started → allow (never trap a worker on an unstarted task — that is the orchestrator's call).

### Investigation targets

**Required** (read before coding):
- planctl/run_reconcile.py:51-67 — verdict semantics; template/skills/work.md.tmpl:121-129 — the canonical nudge wordings to reuse verbatim
- template/skills/work.md.tmpl:131-168 — the orchestrator resume machinery this guard front-runs; the guard must leave every post-guard outcome consumable by that switch
- plugin/hooks/lib.ts — readMarker / runPlanctl / block emitter

**Optional** (reference as needed):
- https://code.claude.com/docs/en/hooks.md — SubagentStop input fields (agent_id, agent_type, agent_transcript_path, stop_hook_active), block semantics

### Risks

- Trapping a legitimately-stopping worker (BLOCKED escalation, tooling_error, unparseable transcript) wastes a worker round at best and burns the 8-block cap at worst — every uncertain branch allows
- The transcript fallback parse must be defensive: missing file, huge file (read bounded), no TASK_ID line → allow

### Test notes

bun units: ladder branches, nudge mapping, BLOCKED multiline match, transcript TASK_ID extraction. Pytest slow-bucket subprocess: block-on-in_progress_uncommitted fixture (planctl shim), allow-on-BLOCKED message, allow-on-stop_hook_active, allow-on-tooling_error, marker-fallback-to-transcript.

## Acceptance

- [ ] Worker stop with reconcile in_progress_committed/in_progress_uncommitted/state_uncommitted → top-level block with the matching Phase 2b nudge naming the task id
- [ ] BLOCKED: last message, stop_hook_active, tooling_error, typed-error/null reconcile, missing task id → all allow (exit 0, no block)
- [ ] done verdict allows and clears the session marker
- [ ] Task id resolves marker-first, transcript-fallback; both paths tested
- [ ] bun test + fast/slow pytest green

## Done summary

## Evidence
