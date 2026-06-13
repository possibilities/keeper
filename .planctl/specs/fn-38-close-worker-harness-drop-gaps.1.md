## Description

Closes F1 and the merged F3 (and files F2), all rooted in task .2's finding that ~24% of worker spawns (135/565) receive Edit/Write in neither the direct tool set nor the deferred registry, with no "deferred tools available" reminder and ToolSearch(select:Edit) returning empty (transcript proof L78-L81). The shipped fn-37 rule at template/agents/worker.md.tmpl:93 ("Write file CONTENT with Write/Edit, never heredocs") cannot be honored by these spawns, so they silently degrade to the giant-heredoc drop mode the epic targeted. Two remedies share this one worker.md.tmpl Phase-1 surface and land as one commit: (1) add a Phase-1 tooling self-check — when neither Edit nor Write is direct, ToolSearch(select:Edit,Write) once and return BLOCKED: TOOLING_FAILURE if both still miss, so the spawn fails loud instead of degrading (F3 completing F1); (2) evaluate declaring Edit,Write in the worker frontmatter allowedTools to force them direct and remove the deferred-registry dependency (needs harness-behavior validation). Separately, file the upstream Claude Code report carrying the task .2 evidence (F2). F1 and F3 are merged because F3 is the concrete fix completing F1's incomplete prose mitigation on the same file.

## Acceptance

- [ ] worker.md.tmpl Phase 1 gains a tooling self-check that returns BLOCKED: TOOLING_FAILURE when neither Edit nor Write is available after a single ToolSearch(select:Edit,Write) probe.
- [ ] The frontmatter allowedTools approach is evaluated and either applied (with validation evidence) or explicitly recorded as rejected with reason.
- [ ] The upstream deferred-tool-registry omission report is filed with the task .2 evidence (transcript handles + 24% partition).
- [ ] The rendered worker agents and the bun test gate stay green.

## Done summary

## Evidence
