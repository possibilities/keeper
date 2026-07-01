## Description

**Size:** S
**Files:** README.md, plugins/plan/README.md, plugins/plan/CLAUDE.md, plugins/plan/subagents.yaml (header), src/autopilot-worker.ts (JSDoc), plugins/plan/hooks/hooks.json (description)

### Approach

Forward-facing doc sweep for the new scheme: plan/README (:55 resolve-task envelope, :155 skill row, :166 guard), plan/CLAUDE.md:32 (agents now per-cell `work` plugins, matcher `^work:worker$`; run `bun scripts/lint-claude-md.ts`), README.md:300/525 (`work` plugins are launcher-selected per dispatch, not scanned), subagents.yaml header comment, autopilot-worker.ts `buildWorkerCommand` JSDoc (:300, "plan plugin always loaded / spawns tier worker_agent" inverts), hooks.json `description`. Observability: `work:worker` erases model/effort from the `SubagentStop`/`subagent_invocations` record — document the recovery via the job name `work::fn-N.M` → task `tier`+`model` join, and leave a `WORK_CELL_KEY` env hook as a cheap future add if inline telemetry is later wanted. Add the CI/acceptance guard asserting nothing named `work` is installed/scanned in a worker's plugin set besides the selected cell.

### Investigation targets

**Required** (read before coding):
- plugins/plan/README.md:55,155,166; plugins/plan/CLAUDE.md:32; README.md:300,525; plugins/plan/subagents.yaml:1; src/autopilot-worker.ts:300
- src/subagent-invocations.ts:261,324 — the (job_id, subagent_type) bridge that now collapses to work:worker

### Risks

- lint-claude-md size/prose gate must stay green; forward-facing only (no dates/fn-ids/past-tense in docs).

### Test notes

A guard test that a stray scanned `work` plugin is rejected/flagged; docs lint green.

## Acceptance

- [ ] All worker-naming/launcher docs reflect per-cell `work` plugins + `work:worker` + launcher `--plugin-dir` selection; lint-claude-md green.
- [ ] Observability recovery (job→task cell join) is documented; a `WORK_CELL_KEY` seam is noted as optional.
- [ ] A guard prevents a foreign `work`-named plugin from shadowing the cells.

## Done summary
Doc sweep for the per-cell work-plugin scheme: resolve-task envelope, /plan:work skill row, plan CLAUDE.md, subagents.yaml header, and hooks.json now describe work:worker + launcher --plugin-dir cell selection; README documents the model/effort observability recovery via plan_ref->task join with an optional WORK_CELL_KEY seam. The foreign-work-name collision guard already ships from task .3.
## Evidence
