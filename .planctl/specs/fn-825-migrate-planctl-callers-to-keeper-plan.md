## Overview

Repoint every `planctl <verb>` command-caller to `keeper plan <verb>`. The surface is concentrated: 46 `plugins/plan/template/**` templates (the canonical source that re-renders the 83 skills + 90 agents), the `Bash(planctl:*)` allowed-tools, and 17 arthack scripts. Both commands work throughout (the `planctl` binary stays alive until the final epic), so this is non-breaking and parallel-safe with the native fold.

## Quick commands

- `promptctl render-plugin-templates --project-root ~/code/keeper/plugins/plan` — re-renders skills/agents from migrated templates
- `rg -n '\bplanctl ' plugins/plan/{skills,agents,template} | wc -l` — should reach 0 (caller invocations)

## Acceptance

- [ ] no `plugins/plan/{skills,agents,template}/**` invokes `planctl <verb>` as a command — all use `keeper plan <verb>`
- [ ] `allowed-tools` declare `Bash(keeper plan:*)` (verified to actually match `keeper plan …` in a real worker spawn) instead of `Bash(planctl:*)`
- [ ] arthack scripts use `keeper plan`
- [ ] rendered `.managed-file-dont-edit` outputs regenerated + committed; skills/agents still function end to end

## Early proof point

Task `.1` (templates + re-render). If the `Bash(keeper plan:*)` permission doesn't match a two-word command prefix in practice, fall back to `Bash(keeper:*)` and note the scope tradeoff.

## References

- Callers: skills (83), agents (90), templates (46), arthack/scripts (17). Templates are canonical — render propagates.
- autopilot dispatch is `/plan:<verb>` (slash skill, `autopilot-worker.ts:261`) — NOT a `planctl` shell, so it is unaffected.

## Rollout

Autopilotable, non-breaking (both commands valid throughout). No daemon restart.
