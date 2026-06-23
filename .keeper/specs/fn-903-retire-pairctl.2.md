## Description

**Size:** S
**Files:** claude/arthack/hooks/pre_tool_use.ts, claude/arthack/hooks/post_tool_use.ts, claude/arthack/hooks/tests/pre_tool_use.test.ts

### Approach

Remove the pairctl→Monitor enforcement advice (the "pairctl send-message must be invoked via
the Monitor tool, not Bash — Bash mode is no longer supported" injection) from the arthack
PreToolUse / PostToolUse hooks, plus the covering test assertions. Excise ONLY the
pairctl-specific branch/strings — leave the rest of the hook logic intact. Forward-facing: no
tombstone comment narrating what was removed.

### Investigation targets

**Required:**
- claude/arthack/hooks/pre_tool_use.ts + post_tool_use.ts (the pairctl advice branch)
- claude/arthack/hooks/tests/pre_tool_use.test.ts (the covering assertions to drop)

### Risks

- Excise only the pairctl branch — do not disturb unrelated hook advice or other tool-routing.

### Test notes

arthack hook tests green after the pairctl assertions are removed.

## Acceptance

- [ ] pairctl→Monitor advice removed from both hooks + its covering test
- [ ] remaining hook logic + tests intact and green

## Done summary

## Evidence
