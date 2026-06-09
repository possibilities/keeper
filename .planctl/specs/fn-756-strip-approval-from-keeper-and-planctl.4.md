## Description

**Size:** S
**Files:** tests/test_arthack_claude_agent_override.py, CLAUDE.md

### Approach

Docs/test-only cleanup, landing after the `/plan:approve` skill is gone
(`← .3`). Drop the `/plan:approve` test prompts from
`tests/test_arthack_claude_agent_override.py` (~:172-173) so the launcher
test no longer references a removed skill. In `CLAUDE.md`, remove any
reference to the `/plan:approve` skill or planctl approval (the
`auto-approve` HOOK references are Claude Code's own permission system —
leave them). The `.planctl/specs/` history files are prior plans — leave
them untouched (forward-only, no tombstoning).

### Investigation targets

**Required** (read before coding):
- tests/test_arthack_claude_agent_override.py:172-173 — /plan:approve test prompts to drop
- CLAUDE.md — grep for `plan:approve` / planctl approval references (distinct from the `auto-approve` permission hook)

### Risks

- Don't touch the `auto-approve`/`permission_request.ts`/`pre_tool_use.ts` hook machinery — that is Claude Code's ExitPlanMode/tool permission system, unrelated to keeper/planctl approval.

### Test notes

Run the affected test file: `uv run pytest tests/test_arthack_claude_agent_override.py`. Green after the prompt edit.

## Acceptance

- [ ] No `/plan:approve` reference remains in `tests/test_arthack_claude_agent_override.py`; the file's tests pass.
- [ ] No keeper/planctl approval reference in `CLAUDE.md`; the `auto-approve` permission-hook prose is left intact.
- [ ] `.planctl/specs/` history untouched.

## Done summary
Dropped the three /plan:approve test prompts from the launcher role-name test (system/tests/test_launcher_plan_role_names.py — the only arthack /plan:approve reference); CLAUDE.md had no keeper/planctl approval refs (only the auto-approve permission-hook prose, left intact). Affected test green (4 passed).
## Evidence
