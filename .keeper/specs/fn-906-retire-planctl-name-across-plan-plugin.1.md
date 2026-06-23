## Description

Sourced from audit finding F1 (fn-889-retire-planctl-name). The fn-889
sweep skipped the `plugins/plan/` plugin surface and `keeper/api.py`
live docstrings, so the planctl name survives across these live,
internally-consistent contracts (verified by repo-wide grep in Phase 2):

- `plugins/plan/package.json:2,4` — package name `planctl-hooks` + description
- `plugins/plan/scripts/promote.sh:15` — promoted binary `dest="${dest_dir}/planctl"` (and lines 2,6,16,37 prose/tmp path)
- `plugins/plan/plugin/hooks/lib.ts` — `PLANCTL_GUARD_BYPASS` env gate (35-37), `~/.local/state/planctl/sessions/` dir (44), `runPlanctl()` (98) spawning `["planctl", ...]` (103), and the `extractPlanctlInvocation` / `planctl_invocation` envelope refs
- `plugins/plan/.gitignore:8-9` — `.planctl/state/` ignore + comment
- `plugins/plan/agents/close-planner.md` + `agents/quality-auditor.md` — `.planctl/` agent-prose state paths
- `keeper/api.py:27,31,671,715` — live `planctl render-approve-context` docstrings (NOT the historical schema-history comments at 99-312, which are frozen)
- `plugins/keeper/plugin/hooks/events-writer.ts:651-675` + `plugins/keeper/skills/await/SKILL.md` — residual `planctl` prose/comments

These share one theme (finish the name retirement) and overlapping
frozen-literal guards, so they land as one coherent commit. Preserve the
frozen `Planctl-*` trailer literals and the `planctl_*` Commit-event data
keys (already retired by task .3). When renaming the binary / package /
guard-env / state-dir, update every internally-consistent reference
together so the contracts stay coherent (a half-rename breaks the guard
or the promote path). Run the fn-889 lint guard (`scripts/lint-retired-name.sh`)
after the sweep — it must stay green.

## Acceptance

- [ ] `plugins/plan/` binary name, package name, `PLANCTL_GUARD_BYPASS` env gate, session-marker dir, and `planctl_invocation` envelope refs no longer spell `planctl`, with every cross-reference updated coherently
- [ ] `keeper/api.py` live docstrings (27, 31, 671, 715) reference the current command name; historical migration comments untouched
- [ ] Residual prose/comments in events-writer.ts and await/SKILL.md swept
- [ ] Frozen `Planctl-*` trailer literals preserved; `scripts/lint-retired-name.sh` green
- [ ] `keeper run test:full` green (touches hook/plugin paths)

## Done summary
Retired the planctl name across the residual plan-plugin surface: renamed the promoted binary (planctl->keeper-plan), package (planctl-hooks->keeper-plan-hooks), guard env gate (PLANCTL_GUARD_BYPASS->KEEPER_PLAN_GUARD_BYPASS), session-marker + epic-id-lock state dir (planctl->keeper), and the guard dispatchers now spawn 'keeper plan' (runPlanctl->runPlanCli). Swept residual planctl prose in api.py live docstrings, events-writer.ts, await/SKILL.md, flock.ts, and the agent prompts. Frozen Planctl-* trailer literals and historical migration comments preserved; lint-retired-name guard green.
## Evidence
